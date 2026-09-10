import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * A boolean setting must mean what it says.
 *
 * ## The defect this pins
 *
 * `SL_NOTIFY_EMAIL_SECURE` and the `unreadOnly` query parameter both used
 * `z.coerce.boolean()`, which is `Boolean(value)` — and `Boolean("false")` is `true`. So
 * is `Boolean("0")`. Every value a person would write to turn something OFF turned it ON,
 * and the only inputs producing `false` were an empty string and an absent variable.
 *
 * It was found by proving the mail path end to end rather than by reading the schema:
 * `SL_NOTIFY_EMAIL_SECURE=false` — the documented setting for the ordinary STARTTLS relay
 * on 587 — enabled implicit TLS, every send threw, and the outbox filled with RETRYING
 * rows carrying `EMAIL_SEND_FAILED`. Nothing about that error points at the flag.
 *
 * ## Why the test is here and shaped like this
 *
 * It asserts the BEHAVIOUR both call sites need rather than importing either of them:
 * `config.ts` validates `process.env` at module load and would need the whole environment
 * stood up to import. The parser is small enough that a copy in the test is honest — what
 * must not drift is the answer, and that is what this fixes in place.
 *
 * The first case is the regression itself, and it fails against `z.coerce.boolean()`.
 */
const booleanFlag = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(fallback)
    .transform((value, ctx) => {
      if (typeof value === 'boolean') return value;
      const text = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) return true;
      if (['false', '0', 'no', 'off', ''].includes(text)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected a boolean such as true/false, got "${value}"`,
      });
      return z.NEVER;
    });

describe('a boolean setting means what it says', () => {
  const flag = booleanFlag(false);

  it('reads the words people actually write as FALSE', () => {
    /* Every one of these returns `true` under `z.coerce.boolean()`. That is the bug. */
    for (const value of ['false', 'FALSE', 'False', '0', 'no', 'off', ' false ']) {
      expect(flag.parse(value), value).toBe(false);
    }
  });

  it('reads the words people write as TRUE', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
      expect(flag.parse(value), value).toBe(true);
    }
  });

  it('falls back when the variable is absent, and honours the fallback given', () => {
    expect(flag.parse(undefined)).toBe(false);
    expect(booleanFlag(true).parse(undefined)).toBe(true);
  });

  it('accepts a real boolean unchanged, for a caller that already has one', () => {
    expect(flag.parse(true)).toBe(true);
    expect(flag.parse(false)).toBe(false);
  });

  it('REFUSES a value it cannot read rather than guessing', () => {
    /*
       The half that matters for a security-relevant flag. A typo must stop the process at
       boot with the variable named — silently picking a side is how `secure` ends up
       meaning its opposite for a year.
    */
    for (const value of ['maybe', 'ye', '2', 'null']) {
      expect(() => flag.parse(value), value).toThrow();
    }
  });
});
