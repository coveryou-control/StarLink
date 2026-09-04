import type pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';

/**
 * Profile and group pictures.
 *
 * Bytes in the database rather than object storage — migration 0025 records why, and the
 * short version is that an avatar is a sub-256KB square shown to everybody who can already
 * see the name beside it, so the grant-quarantine-scan-promote pipeline that attachments
 * need protects nothing here and costs three round trips.
 */
export interface AvatarRow {
  readonly image: Buffer;
  readonly contentType: string;
  readonly updatedAt: string;
}

/** What a caller needs to know to build a URL, without reading the bytes. */
export interface AvatarStamp {
  readonly id: UUID;
  readonly updatedAt: string;
}

export class PgAvatarStore {
  constructor(private readonly pool: pg.Pool) {}

  async setForPrincipal(
    principalId: UUID,
    image: Buffer,
    contentType: string,
    at: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO identity.principal_avatars (principal_id, image, content_type, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (principal_id) DO UPDATE
         SET image = EXCLUDED.image,
             content_type = EXCLUDED.content_type,
             updated_at = EXCLUDED.updated_at`,
      [principalId, image, contentType, at],
    );
  }

  async clearForPrincipal(principalId: UUID): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM identity.principal_avatars WHERE principal_id = $1 RETURNING principal_id`,
      [principalId],
    );
    return result.rows.length > 0;
  }

  async forPrincipal(principalId: UUID): Promise<AvatarRow | undefined> {
    const result = await this.pool.query(
      `SELECT image, content_type, updated_at
         FROM identity.principal_avatars WHERE principal_id = $1`,
      [principalId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      image: row.image as Buffer,
      contentType: row.content_type as string,
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }

  async setForConversation(
    conversationId: UUID,
    image: Buffer,
    contentType: string,
    setBy: UUID,
    at: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversation.conversation_avatars
         (conversation_id, image, content_type, set_by, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (conversation_id) DO UPDATE
         SET image = EXCLUDED.image,
             content_type = EXCLUDED.content_type,
             set_by = EXCLUDED.set_by,
             updated_at = EXCLUDED.updated_at`,
      [conversationId, image, contentType, setBy, at],
    );
  }

  async forConversation(conversationId: UUID): Promise<AvatarRow | undefined> {
    const result = await this.pool.query(
      `SELECT image, content_type, updated_at
         FROM conversation.conversation_avatars WHERE conversation_id = $1`,
      [conversationId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      image: row.image as Buffer,
      contentType: row.content_type as string,
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }

  /**
   * Which of these people have a picture, and when it last changed.
   *
   * Stamps only — no bytes. The list renders thirty avatars and needs to know which of them
   * have an image and what to hang on the URL so a changed picture is not served from a
   * stale cache. Selecting the images to answer that would move megabytes to decide
   * whether to draw initials.
   */
  async stampsFor(ids: readonly UUID[]): Promise<readonly AvatarStamp[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT principal_id AS id, updated_at
         FROM identity.principal_avatars
        WHERE principal_id = ANY($1::uuid[])`,
      [ids],
    );
    return result.rows.map((row) => ({
      id: row.id as UUID,
      updatedAt: (row.updated_at as Date).toISOString(),
    }));
  }
}

/**
 * Whether these bytes actually are the image type they claim to be.
 *
 * ## Why the declared type is not enough
 *
 * A browser sends whatever `Content-Type` it likes and a script sends whatever it wants.
 * The client re-encodes through a canvas before uploading, which is the real protection —
 * anything that was not pixels does not survive being decoded and written back out — but
 * that protection lives on the client, and a caller who skips the client skips it too.
 *
 * So the server checks the bytes. Each of the three accepted formats begins with a fixed
 * signature, and a file that does not start with the one it claims is refused rather than
 * stored and served back later under a type the browser will act on.
 *
 * This is not a scan and does not pretend to be. It is the narrow question "is this a PNG"
 * asked of something that has already been reduced to pixels once.
 */
export function looksLikeImage(bytes: Buffer, contentType: string): boolean {
  if (bytes.length < 12) return false;

  switch (contentType) {
    case 'image/png':
      // \x89 P N G \r \n \x1a \n
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case 'image/jpeg':
      // SOI marker. The trailing EOI is deliberately not checked: a truncated JPEG is a
      // broken picture, not a security problem, and the browser renders what it can.
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/webp':
      // 'RIFF' .... 'WEBP'
      return (
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    default:
      /* An unknown type is refused, never waved through — rule 4's shape applied to a
         content type. */
      return false;
  }
}
