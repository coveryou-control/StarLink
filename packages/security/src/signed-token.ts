/**
 * HMAC-signed opaque tokens.
 *
 * Two things in StarLink are handed to a client and later trusted back: the session
 * cookie and the paging cursor. Both must be unforgeable, and doc §27.14 requires them
 * to use SEPARATE secrets so that one compromise is not both.
 *
 * The codec is generic so that neither use site hand-rolls its own signing — a
 * hand-rolled comparison is where timing leaks and `==` bugs live.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifyFailure =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  /** Signed correctly, but for a different purpose — a cursor presented as a session. */
  | 'WRONG_PURPOSE'
  | 'EXPIRED';

export type VerifyResult<T> =
  | { readonly valid: true; readonly payload: T }
  | { readonly valid: false; readonly reason: VerifyFailure };

export interface SignedTokenCodec<T> {
  sign(payload: T): string;
  verify(token: string): VerifyResult<T>;
}

export interface SignedTokenOptions {
  readonly secret: string;
  /**
   * Domain separation. Bound into the signature so a token minted for one purpose
   * cannot be replayed as another, even if two codecs were ever given the same secret.
   */
  readonly purpose: string;
  /** Rejects short secrets at construction rather than at first use (doc §35.3). */
  readonly minimumSecretLength?: number;
}

const b64url = (input: Buffer): string => input.toString('base64url');

export function createSignedTokenCodec<T>(options: SignedTokenOptions): SignedTokenCodec<T> {
  const minimum = options.minimumSecretLength ?? 32;
  if (options.secret.length < minimum) {
    throw new Error(`signing secret for "${options.purpose}" is shorter than ${minimum} characters`);
  }

  const signature = (body: string): Buffer =>
    createHmac('sha256', options.secret).update(`${options.purpose}.${body}`).digest();

  return {
    sign(payload: T): string {
      const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
      return `${body}.${b64url(signature(body))}`;
    },

    verify(token: string): VerifyResult<T> {
      const separator = token.lastIndexOf('.');
      if (separator <= 0) return { valid: false, reason: 'MALFORMED' };

      const body = token.slice(0, separator);
      const presented = Buffer.from(token.slice(separator + 1), 'base64url');
      const expected = signature(body);

      // Length check first: timingSafeEqual throws on a length mismatch, and a thrown
      // error would itself be an oracle.
      if (presented.length !== expected.length) return { valid: false, reason: 'BAD_SIGNATURE' };
      if (!timingSafeEqual(presented, expected)) return { valid: false, reason: 'BAD_SIGNATURE' };

      try {
        return { valid: true, payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T };
      } catch {
        return { valid: false, reason: 'MALFORMED' };
      }
    },
  };
}
