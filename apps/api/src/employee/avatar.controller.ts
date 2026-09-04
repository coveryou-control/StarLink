/**
 * Profile and group pictures.
 *
 * ## Why not the attachment pipeline
 *
 * StarLink has one, and it is right for attachments: a grant is issued, the client uploads
 * to quarantine, a scanner reports, the object is promoted, and every download mints an
 * audited short-lived grant (§28.1, ADR-012). Every step exists because an attachment is
 * an arbitrary file of arbitrary size handed from one colleague to another.
 *
 * An avatar is none of that. It is a square under 256 KB, it belongs to a person or a
 * group rather than to a conversation — so it does not fit `attachments.conversation_id`,
 * which is NOT NULL — and it is shown to everybody who can already see the name beside it,
 * so a per-object grant protects nothing. Migration 0025 records the reasoning in full.
 *
 * ## What stands in for the scanner
 *
 * Two things, and neither is "we trust the client".
 *
 * The client re-encodes through a canvas before upload: the image is decoded to pixels and
 * written back out. An SVG's script, a polyglot's trailing payload and EXIF carrying
 * somebody's home location all fail to survive that, because none of them are pixels. That
 * is the strong protection, and it is the reason this is safe without a scanner.
 *
 * But it lives on the client, and a caller who skips the client skips it. So the server
 * refuses anything whose bytes do not begin with the signature of the type it claims
 * (`looksLikeImage`), refuses any type outside three, and refuses anything over the
 * ceiling. A relabelled file does not get stored and served back under a type the browser
 * would act on.
 *
 * ## Why reading one needs a session
 *
 * An avatar is not secret. It is also not public: an unauthenticated image endpoint keyed
 * by principal id is an oracle for who works here, answerable by anybody who can guess a
 * UUID. Behind the surface guard it tells a colleague what they could already see.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  AVATAR_CONTENT_TYPES,
  MAX_AVATAR_BYTES,
  type UUID,
} from '@starlink/shared-contracts';
import { looksLikeImage, type PgAvatarStore } from '@starlink/database';
import { decide, toActorContext } from '@starlink/conversation-domain';
import type { ConversationAuthzReader } from '@starlink/database';
import type { IdentityAuthorizationClient } from '@starlink/shared-contracts';

import { AVATAR_STORE, AUTHZ_READER, IDENTITY_CLIENT } from '../tokens.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const uuid = z.string().uuid();

/**
 * The picture, as base64.
 *
 * Base64 in a JSON body rather than multipart: it is one small field, the client already
 * holds it as a data URL from the canvas it re-encoded through, and multipart would mean
 * adding a body parser to a surface that otherwise speaks JSON.
 *
 * The length ceiling is applied to the DECODED bytes below, not to this string — base64 is
 * a third longer than what it encodes, and validating the encoded length would silently
 * move the real limit.
 */
const uploadSchema = z.object({
  contentType: z.enum(AVATAR_CONTENT_TYPES),
  /* A generous string bound so an enormous body is rejected by the parser rather than
     decoded first. 4/3 of the byte ceiling, plus padding and slack. */
  base64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 1024),
});

const stampsSchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((raw) => raw.split(',').filter((part) => part !== ''))
    .refine((ids) => ids.length <= 50)
    .refine((ids) => ids.every((id) => uuid.safeParse(id).success)),
});

@Controller('v1/employee')
@RequireSurface('EMPLOYEE')
export class AvatarController {
  constructor(
    @Inject(AVATAR_STORE) private readonly avatars: PgAvatarStore,
    @Inject(AUTHZ_READER) private readonly authz: ConversationAuthzReader,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
  ) {}

  protected now(): Date {
    return new Date();
  }

  /**
   * Decodes and checks a submitted picture, or returns `undefined`.
   *
   * One place, because both upload routes need exactly the same three answers and a second
   * copy is a second chance for one of them to drift permissive.
   */
  private decode(body: unknown): { image: Buffer; contentType: string } | undefined {
    const parsed = uploadSchema.safeParse(body);
    if (!parsed.success) return undefined;

    let image: Buffer;
    try {
      image = Buffer.from(parsed.data.base64, 'base64');
    } catch {
      return undefined;
    }

    /* Node's base64 decoder is lenient and silently drops invalid characters, so a
       garbage string yields a short buffer rather than throwing. The magic-number check
       below is what actually rejects it. */
    if (image.length === 0 || image.length > MAX_AVATAR_BYTES) return undefined;
    if (!looksLikeImage(image, parsed.data.contentType)) return undefined;

    return { image, contentType: parsed.data.contentType };
  }

  @Put('auth/me/avatar')
  async setMine(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const picture = this.decode(body);
    if (picture === undefined) return refuse();

    const session = request.session!;
    const at = this.now().toISOString();
    await this.avatars.setForPrincipal(
      session.principalId as UUID,
      picture.image,
      picture.contentType,
      at,
    );
    return { updatedAt: at };
  }

  @Delete('auth/me/avatar')
  async clearMine(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    const removed = await this.avatars.clearForPrincipal(session.principalId as UUID);
    /* `false` means there was none, which is the state the caller asked for. Reporting it
       as a failure would make "remove my picture" fail for anybody who never set one. */
    return { removed };
  }

  @Get('avatars')
  async stamps(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    void request.session!;
    const parsed = stampsSchema.safeParse(query);
    if (!parsed.success) return refuse();
    return { avatars: await this.avatars.stampsFor(parsed.data.ids as UUID[]) };
  }

  /**
   * The bytes.
   *
   * `nosniff` because the browser must act on the type we declare rather than on what the
   * content looks like: the whole point of the magic-number check is that the two agree,
   * and sniffing would let a disagreement be resolved in the file's favour.
   *
   * Cached hard and privately. The URL carries the picture's own `updatedAt`, so a changed
   * picture is a different URL and an unchanged one never needs re-fetching — `private`
   * because a shared cache holding one employee's face keyed by URL is a cache that can
   * serve it to somebody without a session.
   */
  @Get('avatars/:principalId')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  @Header('X-Content-Type-Options', 'nosniff')
  async ofPrincipal(
    @Param('principalId') principalIdRaw: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    void request.session!;
    const principalId = uuid.safeParse(principalIdRaw);
    if (!principalId.success) {
      response.status(404).end();
      return;
    }

    const avatar = await this.avatars.forPrincipal(principalId.data as UUID);
    if (avatar === undefined) {
      /* No picture is a 404, and the client falls back to initials. Not an empty 200: an
         empty image body renders as a broken-image glyph in every browser. */
      response.status(404).end();
      return;
    }

    response.setHeader('Content-Type', avatar.contentType);
    response.send(avatar.image);
  }

  @Get('conversations/:conversationId/avatar')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  @Header('X-Content-Type-Options', 'nosniff')
  async ofConversation(
    @Param('conversationId') conversationIdRaw: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    if (!conversationId.success) {
      response.status(404).end();
      return;
    }

    /* A group's picture is part of the conversation, so seeing it is reading it. */
    if (!(await this.mayActOn(request, conversationId.data as UUID, 'conversation.read'))) {
      response.status(404).end();
      return;
    }

    const avatar = await this.avatars.forConversation(conversationId.data as UUID);
    if (avatar === undefined) {
      response.status(404).end();
      return;
    }

    response.setHeader('Content-Type', avatar.contentType);
    response.send(avatar.image);
  }

  /**
   * Sets a group's picture.
   *
   * Authorized with the SEND action, not the read one — the same reasoning as pinning: it
   * changes what every participant sees, so somebody with oversight access over a
   * conversation they are not in must not be able to do it.
   */
  @Put('conversations/:conversationId/avatar')
  async setForConversation(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const picture = this.decode(body);
    if (!conversationId.success || picture === undefined) return refuse();

    if (
      !(await this.mayActOn(request, conversationId.data as UUID, 'conversation.message.send'))
    ) {
      return refuse();
    }

    const session = request.session!;
    const at = this.now().toISOString();
    await this.avatars.setForConversation(
      conversationId.data as UUID,
      picture.image,
      picture.contentType,
      session.principalId as UUID,
      at,
    );
    return { updatedAt: at };
  }

  /** The object check, loaded and decided against what it loaded. */
  private async mayActOn(
    request: AuthenticatedRequest,
    conversationId: UUID,
    action: string,
  ): Promise<boolean> {
    const session = request.session!;
    const at = this.now().toISOString();
    const resource = await this.authz.loadForAuthorization(conversationId, session.principalId, at);
    if (resource === undefined) return false;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return false;
    const temporaryGrants = await this.authz.loadTemporaryGrants(
      conversationId,
      session.principalId,
      at,
    );
    return decide({
      actor: { ...toActorContext(claims.value), temporaryGrants },
      action,
      resource,
      now: at,
    }).allow;
  }
}
