/**
 * Log redaction (brief §39, doc §32.2, NFR-DAT-5).
 *
 * Operational logs and the audit ledger are different records with different retention
 * and different access lists. Logging a whole request body "just for debugging" is how
 * message content and customer contact details end up in a log store that is retained
 * differently and read more widely than the message store.
 *
 * The rule is therefore an ALLOW-LIST on shape and a DENY-LIST on keys, applied at the
 * logger rather than at each call site — because a rule applied per call site is a rule
 * applied inconsistently, and the inconsistent one is the leak.
 */

/**
 * Keys whose VALUES must never reach a log, at any depth.
 *
 * Matched case-insensitively against the whole key, and also as a substring for the
 * obvious carriers (anything containing "token", "secret", "password").
 */
export const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  // message content
  'body',
  'message',
  'messagebody',
  'text',
  'content',
  'preview',
  'lastmessagepreview',
  'snippet',
  'draft',
  'transcript',
  'summary',
  // customer identifiers and contact details
  'phone',
  'mobile',
  'msisdn',
  'email',
  'emailaddress',
  'pan',
  'aadhaar',
  'dob',
  'address',
  'accountnumber',
  'policynumber',
  'claimnumber',
  'displayname',
  // Bare `name` is redacted deliberately. It is ambiguous — it carries provider
  // labels and people's names equally, and no value pattern can tell a person's name
  // from a product's. The convention is therefore: QUALIFY THE KEY. `providerName`,
  // `teamName`, `queueName` and `eventName` all pass; a person's name always uses
  // `displayName` or `customerName`, which never pass.
  'name',
  'firstname',
  'lastname',
  'customername',
  // credentials and session material
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'setcookie',
  'sessionid',
  'credential',
  'credentialhash',
  'otp',
  'code',
  'proof',
  'apikey',
  'signature',
  // attachments
  'filename',
  'originalfilename',
  'attachment',
  'file',
  'bytes',
  'buffer',
  // whole payloads
  'requestbody',
  'responsebody',
  'payload',
  'params',
  'query',
]);

const FORBIDDEN_SUBSTRINGS: readonly string[] = Object.freeze([
  'token',
  'secret',
  'password',
  'credential',
  'cookie',
  'apikey',
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_KEYS);

export const REDACTED = '[redacted]';

export function isForbiddenKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[_-]/g, '');
  if (FORBIDDEN_SET.has(normalised)) return true;
  return FORBIDDEN_SUBSTRINGS.some((fragment) => normalised.includes(fragment));
}

/**
 * Value-level defence for the case a key does not catch: a free-text field that
 * happens to contain something identifying. This is not a substitute for the key rule
 * — it is the second layer, and it deliberately errs toward over-redaction.
 */
const VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, // email
  // Phone with an international prefix. A plain \b will not do the job here: `+` is
  // not a word character, so \b never matches before it and `+919876543210` slips
  // through — which is exactly how it slipped through the first version of this rule.
  /(?<![\w-])\+?\d{1,3}[-\s]?\d{10}(?![\w-])/g,
  /(?<![\w-])\d{10}(?![\w-])/g, // bare 10-digit national number
  /\b[A-Z]{5}\d{4}[A-Z]\b/g, // PAN
  /(?<![\w-])\d{12}(?![\w-])/g, // Aadhaar-length digit run
  /\b(?:eyJ|Bearer\s)[\w.-]+/g, // JWT / bearer token
]);

export function redactValueText(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

const MAX_DEPTH = 6;

/**
 * Recursively redact an arbitrary log payload.
 *
 * Unknown structures are traversed rather than trusted: a nested object is exactly
 * where an unreviewed field arrives.
 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') return redactValueText(input);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (input instanceof Date) return input.toISOString();
  if (input instanceof Error) {
    return { name: input.name, message: redactValueText(input.message) };
  }
  if (Array.isArray(input)) return input.map((item) => redact(item, depth + 1));

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = isForbiddenKey(key) ? REDACTED : redact(value, depth + 1);
    }
    return out;
  }
  return REDACTED;
}
