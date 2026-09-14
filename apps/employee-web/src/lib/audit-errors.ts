/**
 * What went wrong, in words, for somebody auditing rather than debugging.
 *
 * ## The defect this exists for
 *
 * Every load on the oversight surface used to end in `catch { setRows([]) }`. That turns a
 * stopped API, a 500, a rate limit and a genuine absence of data into the same picture: an
 * empty panel. It was reported exactly as it would have to be — "I cannot see any
 * conversations, the view appears empty" — and there was nothing on the screen to say
 * otherwise, because the screen could not tell the difference either.
 *
 * An oversight surface is the worst place for that ambiguity. "There are no conversations"
 * and "I could not ask" are opposite answers to a compliance question, and a view that
 * renders them identically will eventually be believed.
 *
 * Lives in `lib/` rather than beside one screen because the sidebar panel, the roster and
 * the file list all have to say the same thing about the same failure — three copies of
 * this wording is three chances for one of them to keep reporting "no results" for a
 * network error.
 */
import { ApiError } from './api-client';

const UNREACHABLE =
  'Could not reach the API. It may be restarting, or this page may be pointed at a different one.';

export function describeAuditFailure(error: unknown): string {
  if (error instanceof ApiError) {
    /* `api-client` wraps a network failure as an ApiError with status 0, so "could not
       reach" arrives here looking like a refusal. Reporting it as "refused" would be the
       same confident-and-wrong answer this whole helper exists to stop. */
    if (error.status === 0) return UNREACHABLE;
    if (error.status === 404) {
      return 'The server declined that request. This account may no longer hold the audit permission.';
    }
    if (error.status === 429) return 'Too many requests at once. Wait a moment and try again.';
    if (error.status >= 500) return `The server failed to answer (${error.status}).`;
    return `The request was refused (${error.status}).`;
  }
  /* A TypeError from `fetch` is the API being unreachable — stopped, restarting, or a
     different origin than this page was built against. The commonest cause by far, and the
     one an empty panel hid completely. */
  return UNREACHABLE;
}

/** One instant, as a person reads it. */
export function auditWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
