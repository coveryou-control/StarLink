/**
 * Reads the one-time code out of the API's dev log.
 *
 * The code is deliberately unreachable any other way: `LocalOtpIdentity` stores only an
 * HMAC of it, and the API never returns it in a response — "the code itself never appears
 * in a response or a log" holds for the structured logger, and the plain
 * `[dev-otp] …` line exists only for local development.
 *
 * Reading it here is what keeps the customer journey a journey. The alternative — minting
 * a verified session cookie and injecting it into the browser context, which is what the
 * API integration tests correctly do — would skip the front door, and the front door is
 * precisely the part a browser suite exists to exercise.
 */
import { readFileSync } from 'node:fs';

import { API_LOG } from './env.js';

const LINE = /\[dev-otp\] (\w+) -> (.+): (\d{4,12})/g;

/** Every code issued to `destination` so far, oldest first. */
function codesFor(destination: string): { codes: string[]; log: string } {
  let log = '';
  try {
    log = readFileSync(API_LOG, 'utf8');
  } catch {
    // The API may not have written yet; the file is created before it starts.
  }
  const codes: string[] = [];
  for (const match of log.matchAll(LINE)) {
    if (match[2] === destination && match[3] !== undefined) codes.push(match[3]);
  }
  return { codes, log };
}

/**
 * How many codes this number has already been sent.
 *
 * Captured immediately BEFORE pressing "Send code", and handed back to `waitForOtp`, so a
 * customer who verifies twice in one test is given the second code rather than the first.
 * Without it the second verification read a code that was already spent, typed it, and sat
 * on the code screen until the test timed out — which is what happens when a returning
 * customer comes back to the widget.
 */
export function otpsIssued(destination: string): number {
  return codesFor(destination).codes.length;
}

/**
 * Polls for the newest code issued to `destination`.
 *
 * Matched on the destination rather than "the last line", so a parallel run or a retry
 * cannot hand this test somebody else's code — the failure that would produce is a
 * confusing one-off, not a reproducible red.
 *
 * `after` is the number of codes that had already been issued when the request was made;
 * this waits until a LATER one appears. Defaulting it to 0 keeps the first verification
 * behaving exactly as before.
 */
export async function waitForOtp(
  destination: string,
  options: { timeoutMs?: number; after?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const after = options.after ?? 0;
  const deadline = Date.now() + timeoutMs;
  let seen = '';

  while (Date.now() < deadline) {
    const { codes, log } = codesFor(destination);
    seen = log;

    if (codes.length > after) return codes[codes.length - 1] as string;

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    `No dev OTP number ${after + 1} for ${destination} within ${timeoutMs}ms.\n` +
      `Log tail:\n${seen.split('\n').slice(-15).join('\n')}`,
  );
}

/** A distinct number per run, so a re-run never matches a previous run's code. */
export function uniqueMobile(): string {
  return `+9198${String(Date.now()).slice(-8)}`;
}
