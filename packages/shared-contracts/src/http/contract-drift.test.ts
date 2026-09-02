/**
 * Numbers in the HTTP contract that a second file must not restate.
 *
 * The class of defect this guards is not a wrong value — it is two right-looking values in
 * two files that disagree, where neither side can see the other. `SEARCH_MINIMUM_TERM_LENGTH`
 * was exactly that: `packages/search` refused below 3, the employee web app sent at 2, and
 * because §27.3 makes every refusal uniform, the client could not tell "your term is too
 * short" from "the index is down". It rendered the outage message. Somebody typing "hi"
 * was told the product was broken.
 *
 * Grepping for the literal is the assertion, deliberately. A test that imports both
 * constants and compares them passes the moment somebody stops importing and writes the
 * number again — which is the failure, not the fix.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SEARCH_MINIMUM_TERM_LENGTH } from './employee-routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

const read = (relative: string): string => readFileSync(resolve(REPO, relative), 'utf8');

describe('the search minimum is declared once', () => {
  it('is a number the contract owns', () => {
    // Not an arbitrary assertion: FR-SRCH-5's floor is a product rule, and a change to it
    // is a change to what every search endpoint accepts. It should be deliberate enough to
    // edit this line.
    expect(SEARCH_MINIMUM_TERM_LENGTH).toBe(1);
  });

  it('never refuses a character somebody has actually typed', () => {
    /*
       The floor's only remaining job is to refuse the EMPTY term, which is not a search.
       Anything above 1 is a length gate, and a length gate does not bound a result set —
       the scope JOIN, the page cap and the rate limiter do. Three of them at 3, 2 and 2
       across messages, the directory and files is what made a search box that could not
       find "hi", could not find a colleague by initials, and reported an outage while
       somebody was still typing.
    */
    expect(SEARCH_MINIMUM_TERM_LENGTH).toBeLessThanOrEqual(1);
    expect(SEARCH_MINIMUM_TERM_LENGTH).toBeGreaterThan(0);
  });

  for (const consumer of [
    'packages/search/src/search-messages.ts',
    'apps/employee-web/src/components/conversation-search.tsx',
    // The other two search surfaces. They had floors of 2 and 2 while messages had 3, so
    // one search box behaved three different ways depending on which facet you looked at.
    'apps/api/src/employee/search.controller.ts',
    'apps/api/src/employee/directory.controller.ts',
    'adapters/employee-directory/src/local/local-directory.ts',
  ]) {
    it(`${consumer} reads it rather than restating it`, () => {
      const source = read(consumer);

      expect(
        source.includes('SEARCH_MINIMUM_TERM_LENGTH'),
        `${consumer} must import SEARCH_MINIMUM_TERM_LENGTH from @starlink/shared-contracts`,
      ).toBe(true);

      /*
         And must not carry its own copy of the number. The pattern is narrow on purpose —
         it looks for a bare numeric assignment to a minimum-length-shaped name, not for
         the digit 3, which appears legitimately all over both files.
      */
      const restated = /(?:MIN(?:IMUM)?[_A-Z]*(?:LENGTH|LEN|CHARS)|min(?:imum)?(?:Length|Len|Chars))\s*[:=]\s*\d+/.exec(
        source,
      );
      expect(
        restated?.[0],
        `${consumer} restates the minimum as a literal (${restated?.[0] ?? ''}); import it instead`,
      ).toBeUndefined();
    });
  }
});
