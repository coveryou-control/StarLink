/**
 * Firebase Cloud Messaging, over HTTP v1, with no SDK.
 *
 * ## Why not `firebase-admin`
 *
 * The package pulls a large dependency tree into an adapter whose entire job is: mint an
 * OAuth token from a service account, and POST some JSON. Node signs RS256 with its own
 * `crypto`, so the whole exchange is two `fetch` calls and about forty lines. §36's
 * adapter rule is that the boundary is the interface, not the vendor's client — and the
 * smaller the adapter, the less there is to reason about when it is the thing between a
 * notification and a person's phone.
 *
 * It also keeps StarLink honest about what leaves the building. Everything sent to Google
 * is visible in one `fetch` body in this file.
 *
 * ## The access token is cached
 *
 * Google issues an hour-long token. Minting one per notification would add a round trip
 * and a signature to every push, and a burst of twenty would make twenty of them. It is
 * refreshed a minute before expiry, because a token that expires mid-flight fails a send
 * that had nothing wrong with it.
 *
 * ## Verdicts, and which are permanent
 *
 * FCM distinguishes a token that is gone from a service that is briefly unavailable, and
 * the distinction matters: retrying an `UNREGISTERED` token forever fills the outbox with
 * rows that can never succeed, while dead-lettering a 503 loses a notification to a blip.
 *
 *   UNREGISTERED / INVALID_ARGUMENT / NOT_FOUND -> permanent. The token is deleted.
 *   anything else, including 429 and 5xx        -> retryable.
 */
import crypto from 'node:crypto';

export interface FcmSenderOptions {
  readonly projectId: string;
  readonly clientEmail: string;
  /** PEM. Service-account JSON escapes the newlines; the caller unescapes them. */
  readonly privateKey: string;
  /** Test seam. Production passes nothing and gets the real endpoints. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export type FcmOutcome =
  | { readonly kind: 'DELIVERED' }
  | { readonly kind: 'TOKEN_GONE'; readonly reason: string }
  | { readonly kind: 'RETRYABLE'; readonly reason: string };

/** What a push carries. Deliberately not the message — see `push-transport.ts`. */
export interface FcmMessage {
  readonly title: string;
  readonly body: string;
  /** Where tapping it should go. Read by the service worker's `notificationclick`. */
  readonly url?: string;
  /** Collapses repeats about the same thing into one notification on the device. */
  readonly tag?: string;
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class FcmSender {
  private accessToken?: string;
  private expiresAt = 0;

  constructor(private readonly options: FcmSenderOptions) {}

  private get fetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * A service-account access token, minted by signed assertion.
   *
   * The JWT is signed with the account's private key and exchanged for a bearer token —
   * the standard two-legged flow, written out because it is short enough to read.
   */
  private async authorise(): Promise<string> {
    if (this.accessToken !== undefined && this.now < this.expiresAt) return this.accessToken;

    const issued = Math.floor(this.now / 1000);
    const claim = {
      iss: this.options.clientEmail,
      scope: SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issued,
      exp: issued + 3600,
    };
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
      JSON.stringify(claim),
    )}`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(unsigned)
      .sign(this.options.privateKey);
    const assertion = `${unsigned}.${base64url(signature)}`;

    const response = await this.fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`token endpoint refused the assertion (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string') throw new Error('token endpoint returned no token');

    this.accessToken = body.access_token;
    /* A minute early, so a token cannot expire between this check and the send. */
    this.expiresAt = this.now + ((body.expires_in ?? 3600) - 60) * 1000;
    return this.accessToken;
  }

  async send(token: string, message: FcmMessage): Promise<FcmOutcome> {
    let bearer: string;
    try {
      bearer = await this.authorise();
    } catch (error) {
      /* A credential problem is not the token's fault and must not delete it. */
      return { kind: 'RETRYABLE', reason: error instanceof Error ? error.message : 'auth failed' };
    }

    const response = await this.fetch(
      `https://fcm.googleapis.com/v1/projects/${this.options.projectId}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            /*
               `data`, not `notification`.

               A `notification` block makes the BROWSER render the push, which means the
               payload has to contain the finished words and the service worker never
               sees it. Sending data keeps the rendering in `sw.js`, where the product
               decides what a notification looks like — and, more importantly, where it
               can choose to show less than it was given.
            */
            data: {
              title: message.title,
              body: message.body,
              ...(message.url !== undefined ? { url: message.url } : {}),
              ...(message.tag !== undefined ? { tag: message.tag } : {}),
            },
            webpush: {
              headers: {
                /* Four hours. A notification about a conversation is worth nothing the
                   next morning, and FCM will stop trying rather than wake a device with
                   yesterday's news. */
                TTL: '14400',
                Urgency: 'normal',
              },
            },
          },
        }),
      },
    );

    if (response.ok) return { kind: 'DELIVERED' };

    const detail = await response.text().catch(() => '');
    const status = /"status"\s*:\s*"([A-Z_]+)"/.exec(detail)?.[1] ?? '';
    const gone =
      status === 'UNREGISTERED' ||
      status === 'NOT_FOUND' ||
      status === 'INVALID_ARGUMENT' ||
      response.status === 404;

    return gone
      ? { kind: 'TOKEN_GONE', reason: status || `HTTP ${response.status}` }
      : { kind: 'RETRYABLE', reason: status || `HTTP ${response.status}` };
  }
}
