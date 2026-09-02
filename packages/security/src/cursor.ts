/**
 * Opaque paging cursors (FR-MSG-3/4, doc §38 KEEP+IMPROVE).
 *
 * Two properties, both load-bearing:
 *
 *   1. **Signed.** The reference platform used an unsigned cursor, and doc §38 records
 *      the improvement: "an unsigned cursor is a client-supplied database query".
 *      A caller must not be able to hand us arbitrary ordering keys.
 *   2. **Compound.** The cursor carries `(createdAt, id)`, not an offset. Offset paging
 *      degrades linearly with depth AND is wrong under concurrent insertion — a row can
 *      repeat or be skipped between pages. The id is the tiebreaker that makes paging
 *      deterministic when two messages share a timestamp.
 */
import { createSignedTokenCodec, type SignedTokenCodec } from './signed-token.js';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

export interface MessageCursor {
  /** Ordering key, matching the leading columns of `messages_page_idx`. */
  readonly createdAt: Timestamp;
  readonly id: UUID;
  /** Bound so a cursor from one thread cannot be replayed against another. */
  readonly conversationId: UUID;
}

export type CursorDecode =
  | { readonly ok: true; readonly cursor: MessageCursor }
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'WRONG_CONVERSATION' };

export class CursorCodec {
  private readonly codec: SignedTokenCodec<MessageCursor>;

  constructor(secret: string) {
    // A separate secret from the session key: one compromise must not be both (§27.14).
    this.codec = createSignedTokenCodec<MessageCursor>({ secret, purpose: 'cursor' });
  }

  encode(cursor: MessageCursor): string {
    return this.codec.sign(cursor);
  }

  /**
   * Decodes and binds the cursor to the conversation being read.
   *
   * Without the binding check, a validly-signed cursor from thread A could be used to
   * page thread B — not a disclosure by itself, since the query is still scoped by
   * conversation, but it would produce silently wrong pages.
   */
  decode(token: string, conversationId: UUID): CursorDecode {
    const result = this.codec.verify(token);
    if (!result.valid) {
      return { ok: false, reason: result.reason === 'MALFORMED' ? 'MALFORMED' : 'BAD_SIGNATURE' };
    }
    if (result.payload.conversationId !== conversationId) {
      return { ok: false, reason: 'WRONG_CONVERSATION' };
    }
    return { ok: true, cursor: result.payload };
  }
}

export interface ConversationListCursor {
  /** Ordering key: `(last_activity_at, conversation_id)` descending. */
  readonly lastActivityAt: Timestamp;
  readonly id: UUID;
  /** Bound to the owner of the list, not to a conversation. */
  readonly principalId: UUID;
}

export type ConversationListCursorDecode =
  | { readonly ok: true; readonly cursor: ConversationListCursor }
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'WRONG_PRINCIPAL' };

/**
 * Cursor for the conversation LIST.
 *
 * Separate from {@link CursorCodec} because the binding is different, and the binding is
 * the security property. A message cursor is scoped to a thread; a list cursor is scoped
 * to a person, since the list itself is "your threads". Binding it to the principal means
 * a cursor lifted from one employee's response cannot be replayed against another's list
 * to walk their conversations — the query is scoped by participation anyway, so this is
 * defence in depth rather than the boundary, but an unbound cursor is still a
 * client-supplied ordering key (§38).
 */
export class ConversationListCursorCodec {
  private readonly codec: SignedTokenCodec<ConversationListCursor>;

  constructor(secret: string) {
    // A distinct purpose string, so a message cursor cannot be presented as a list
    // cursor even though both are signed with the same secret (§27.14 purpose binding).
    this.codec = createSignedTokenCodec<ConversationListCursor>({
      secret,
      purpose: 'conversation-list-cursor',
    });
  }

  encode(cursor: ConversationListCursor): string {
    return this.codec.sign(cursor);
  }

  decode(token: string, principalId: UUID): ConversationListCursorDecode {
    const result = this.codec.verify(token);
    if (!result.valid) {
      return { ok: false, reason: result.reason === 'MALFORMED' ? 'MALFORMED' : 'BAD_SIGNATURE' };
    }
    if (result.payload.principalId !== principalId) {
      return { ok: false, reason: 'WRONG_PRINCIPAL' };
    }
    return { ok: true, cursor: result.payload };
  }
}
