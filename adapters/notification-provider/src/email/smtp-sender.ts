/**
 * SMTP delivery for employee notification (A-21, §36.4, N-07 answered 2026-08-28).
 *
 * ## What the document left open, and what it did not
 *
 * §36.4 specifies "Adapter over a transactional provider; **provider unnamed**", and
 * §15.9 explicitly rejects choosing one at design time: "Committing now would be
 * inventing a business answer, which the brief forbids." So the provider was always a
 * decision for the infrastructure owner, and it was taken on 2026-08-28: **a corporate
 * SMTP relay**, on the grounds that employee notification is internal traffic and routing
 * it through a third party would add a processing agreement for recipients who are all
 * inside the company.
 *
 * SMTP is also the least committal implementation of that decision. SES, SendGrid and
 * Postmark all expose SMTP endpoints, so moving to a managed provider is a change of host
 * and credentials rather than a rewrite. A vendor SDK, if one is ever wanted for bounce
 * feedback, is a second implementation of `EmailSender` beside this one.
 *
 * ## Configured or absent — never a stub
 *
 * `EmailNotificationTransport` refuses when it has no sender, and that refusal is load-
 * bearing: rows accumulate as RETRYING, the depth gauge climbs, and §29.6's "provider
 * outage — rows accumulate as pending and drain on recovery" behaves as designed. So this
 * class is constructed ONLY when a host is configured. An unconfigured environment gets
 * no sender at all rather than a sender that pretends.
 *
 * ## Connection handling
 *
 * One pooled transport, reused across sends. The worker delivers in batches and a fresh
 * TCP+TLS handshake per notification would make a burst of twenty cost twenty handshakes
 * against a relay that is usually rate-limited on connections rather than on messages.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { RenderedNotification } from '@starlink/shared-contracts';
import type { EmailSender } from './email-transport.js';

export interface SmtpSenderOptions {
  readonly host: string;
  readonly port: number;
  /**
   * Implicit TLS (port 465). When false, nodemailer still upgrades via STARTTLS where the
   * relay offers it — which is the ordinary case for an internal relay on 587.
   */
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  /** Envelope sender. A relay will usually refuse a domain it does not own. */
  readonly from: string;
  /** Test seam. Production passes nothing and gets a real pooled transport. */
  readonly transporter?: Transporter;
}

export class SmtpEmailSender implements EmailSender {
  readonly #transporter: Transporter;
  readonly #from: string;

  constructor(options: SmtpSenderOptions) {
    this.#from = options.from;
    this.#transporter =
      options.transporter ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        // Pooled for the reason in the header: a delivery batch should cost one
        // handshake, not one per row.
        pool: true,
        ...(options.user !== undefined && options.password !== undefined
          ? { auth: { user: options.user, pass: options.password } }
          : {}),
      });
  }

  /**
   * Sends one notification.
   *
   * Throws on failure rather than returning a verdict, because the transport above
   * classifies: it turns a throw into a retryable `EMAIL_SEND_FAILED`, and decides
   * separately that a missing address is permanent. Classifying here as well would put
   * the retry policy in two places, and the second one would drift.
   */
  async send(to: string, payload: RenderedNotification, idempotencyKey: string): Promise<void> {
    await this.#transporter.sendMail({
      from: this.#from,
      to,
      subject: payload.subject ?? 'StarLink notification',
      text: payload.body,
      headers: {
        /**
         * §29.5: "Each row carries a stable key; adapters that support idempotency keys
         * receive it." SMTP has no idempotency facility, so the key travels as the
         * Message-ID — which relays and mailboxes deduplicate on, turning a rare
         * at-least-once duplicate into none for most recipients.
         *
         * The domain half is taken from the envelope sender so the identifier is
         * globally unique without inventing a hostname.
         */
        'Message-ID': `<${idempotencyKey}@${this.#from.split('@')[1] ?? 'starlink.local'}>`,
        // A notification is not a conversation. Auto-responders replying to it would
        // create traffic nobody reads, addressed to a sender nobody monitors.
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'All',
      },
    });
  }
}
