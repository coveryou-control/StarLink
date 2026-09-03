/**
 * `likePattern`, and the reason it is shared rather than written per call site.
 *
 * Three queries built an `ILIKE` pattern by interpolation — message bodies, filenames and
 * the employee directory — and only the first escaped the term. Typing a single `%` into
 * the search box therefore returned every active employee in the company: a corpus dump
 * through a wildcard, which is the exact outcome FR-SRCH-5 is written to prevent, reached
 * by a route the length floor never covered.
 *
 * It was found by typing `%` into the box. Nothing in the type system, the linter or the
 * review would have said a word.
 */
import { describe, expect, it } from 'vitest';

import { likePattern } from './employee-routes.js';

describe('likePattern', () => {
  it('wraps an ordinary term so it matches anywhere in the value', () => {
    expect(likePattern('rahul')).toBe('%rahul%');
  });

  it('escapes the wildcards, so a search is not a pattern', () => {
    // The one that mattered: `%` alone matched every row.
    expect(likePattern('%')).toBe('%\\%%');
    // `_` matches any single character, so "a_b" would have matched "axb".
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('q1_report')).toBe('%q1\\_report%');
  });

  it('escapes the escape character first', () => {
    /*
       Order is load-bearing. Escape `%` before `\` and the backslash this function has
       just inserted gets escaped in turn, producing `\\%` — a literal backslash followed
       by a wildcard, which is both wrong and still a wildcard.
    */
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
    expect(likePattern('\\%')).toBe('%\\\\\\%%');
  });

  it('leaves everything else alone', () => {
    // Regex metacharacters are not LIKE metacharacters; escaping them would make the
    // pattern fail to match text that contains them.
    expect(likePattern('a.b*c[d]')).toBe('%a.b*c[d]%');
    expect(likePattern('what happended bro?')).toBe('%what happended bro?%');
    expect(likePattern('')).toBe('%%');
  });
});
