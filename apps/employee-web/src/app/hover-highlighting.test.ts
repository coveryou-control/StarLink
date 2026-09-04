import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No control may draw a box, a shade or a ring behind itself on hover.
 *
 * ## Why this is a test and not a review note
 *
 * Hover backgrounds arrive one at a time. Each one is a single plausible line in the rule
 * for a new component — `background: var(--hover)` looks like part of writing a button —
 * and no reviewer rejects one of them. Fifty-nine of them had accumulated before anybody
 * described the app as "highlighted and shaded on everything I touch", which is what it
 * had become and what no single diff had ever said.
 *
 * So the line is held here. Adding one back fails the build with the selector named.
 *
 * ## What is still allowed, and why the distinction matters
 *
 * `:hover` itself is not the problem. Two different things wear it:
 *
 *   .conversation-row:hover      { background: var(--hover); }  <- a shaded box. Banned.
 *   .message-row:hover .actions  { opacity: 1; }                <- reveals a control. Fine.
 *
 * The second is how the message hover bar and the "remove member" button exist at all. A
 * blanket ban on `:hover` would delete them, so this checks the DECLARATIONS rather than
 * the selector: what is refused is painting something behind the pointer. Colour shifts,
 * reveals and the underline on a link all pass, because none of them draw a box.
 *
 * ## The two exemptions
 *
 * The scrollbar thumb keeps its darkening — it is the browser's own convention for "you
 * can grab this", it is six pixels wide, and it is not drawn behind any content.
 *
 * A rule whose selector list also contains a NON-hover state (`[aria-expanded='true']`,
 * `[aria-current='page']`) is not a hover rule; it is a state rule that hover happens to
 * share. Those were split when the sweep ran, so a mixed list reaching this test means
 * somebody has re-merged them, and the check treats the whole rule as suspect rather than
 * quietly passing it.
 */

const CSS = readFileSync(join(__dirname, 'globals.css'), 'utf8');

/** Declarations that put something visible behind the thing under the pointer. */
const PAINTS_A_BOX =
  /^\s*(background|background-color|background-image|box-shadow|outline|border|border-color|border-[a-z]+-color|filter|backdrop-filter)\s*:/i;

const EXEMPT_SELECTOR = /::-webkit-scrollbar/;

/** Every `selector { declarations }` pair, comment- and nesting-aware enough for this file. */
function leafRules(css: string): { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments)) !== null) {
    rules.push({
      selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
      body: match[2] ?? '',
    });
  }
  return rules;
}

describe('hover states never paint a highlight', () => {
  const hoverRules = leafRules(CSS).filter(
    (rule) =>
      rule.selector.includes(':hover') &&
      !rule.selector.startsWith('@') &&
      !EXEMPT_SELECTOR.test(rule.selector),
  );

  it('finds the hover rules it is supposed to be checking', () => {
    /*
       A guard whose subject has vanished passes for the wrong reason. If a refactor moves
       these rules into another stylesheet, this fails and says so rather than reporting
       green over a file it is no longer reading.
    */
    expect(hoverRules.length).toBeGreaterThan(3);
  });

  it('declares no background, shadow, ring or tinted border', () => {
    const offenders = hoverRules
      .flatMap((rule) =>
        rule.body
          .split(';')
          .filter((declaration) => PAINTS_A_BOX.test(declaration))
          .map((declaration) => `${rule.selector} { ${declaration.trim()} }`),
      )
      .sort();

    expect(offenders).toEqual([]);
  });

  it('keeps hover rules that only reveal a control', () => {
    /*
       The positive half. Without it, deleting every `:hover` in the file would satisfy the
       check above — and the message actions, which only exist on hover, would be gone with
       no test objecting.
    */
    const reveals = hoverRules.filter((rule) => /opacity\s*:\s*1/.test(rule.body));
    const revealed = reveals.map((rule) => rule.selector).join(' ');

    expect(revealed).toContain('.message-row:hover .message-actions');
    expect(revealed).toContain('.person-row:hover .person-action');
  });
});
