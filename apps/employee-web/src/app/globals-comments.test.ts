/**
 * The stylesheet's comments must balance.
 *
 * This exists because of a specific failure, not a hypothetical one. A comment block was
 * deleted by matching its body and its closing delimiter while leaving the OPENING one
 * behind, and CSS then treated everything from the next rule to the following close — about
 * twenty declarations — as comment text. Nothing failed: the build compiled, the page
 * rendered, lint said nothing, and the only symptom was that the account avatar at the foot
 * of the rail quietly became a default white button.
 *
 * That is the shape of the problem. An unclosed comment in CSS does not error, it DELETES
 * rules, and the deletion is only visible to somebody who happens to look at the exact
 * element affected. This sheet is over seven thousand lines and roughly a third of it is
 * prose, so the odds of noticing are poor.
 *
 * The check is deliberately blunt: scan for each comment opener and require a closer after
 * it. CSS has no nested comments and no string form in which the sequence means something
 * else that this could trip over.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SHEET = resolve(dirname(fileURLToPath(import.meta.url)), 'globals.css');

describe('globals.css', () => {
  const css = readFileSync(SHEET, 'utf8');

  const lineOf = (index: number): number => css.slice(0, index).split('\n').length;

  it('closes every comment it opens', () => {
    let cursor = 0;
    let blocks = 0;
    let unclosedAt: number | undefined;

    for (;;) {
      const open = css.indexOf('/*', cursor);
      if (open === -1) break;
      const close = css.indexOf('*/', open + 2);
      if (close === -1) {
        unclosedAt = lineOf(open);
        break;
      }
      blocks += 1;
      cursor = close + 2;
    }

    expect(
      unclosedAt,
      unclosedAt === undefined
        ? ''
        : `An unclosed /* at line ${unclosedAt} silently comments out every rule after it ` +
          'until the next */. Nothing else will report this.',
    ).toBeUndefined();

    // The scan must have found something to check; a regex that matched nothing would make
    // the assertion above vacuous, which is how a source-scanning guard fails silently.
    expect(blocks).toBeGreaterThan(100);
  });

  it('has balanced braces', () => {
    // Same class of defect through a different door: a missing `}` swallows the following
    // selectors into the previous rule's block, where they do nothing.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const open = (withoutComments.match(/\{/g) ?? []).length;
    const close = (withoutComments.match(/\}/g) ?? []).length;
    expect(
      open - close,
      `${open} '{' against ${close} '}' — the sheet has an unclosed or extra block`,
    ).toBe(0);
  });
});
