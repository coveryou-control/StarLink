import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The bubble's two load-bearing flex declarations, which have each been lost once.
 *
 * ## Why a test over the stylesheet text
 *
 * Both of these are single lines whose absence produces no error anywhere. The layout
 * still works — it just works wrongly, in a way you have to send a long message to see.
 *
 *   - `justify-content: flex-end` on `.message-main`. The bubble is a wrapping flex row of
 *     [words][time + ticks]. When the words fill the line the meta wraps onto its own, and
 *     the wrapped line inherits the row's default `flex-start` — so a long message put its
 *     timestamp at the bubble's bottom LEFT while every short message had it on the right.
 *
 *   - `margin-right: auto` on `.message-body`. Without it, `flex-end` pushes the whole
 *     line right, so a three-word message reads as right-aligned text inside a
 *     left-aligned bubble.
 *
 * The first was written, then lost when this stylesheet was reverted during unrelated
 * work, and nothing noticed until the rendered page was measured again. A grep is a weak
 * check for a layout, but it is exactly strong enough for "somebody deleted the line".
 */

const CSS = readFileSync(join(__dirname, 'globals.css'), 'utf8');

/** The body of the first rule with this exact selector, comments stripped. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `${selector} is not in globals.css any more`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the message bubble keeps its meta on the right', () => {
  it('right-aligns the wrapped line of .message-main', () => {
    expect(ruleBody('.message-main')).toMatch(/justify-content:\s*flex-end/);
  });

  it('leaves the words themselves on the left', () => {
    expect(ruleBody('.message-body')).toMatch(/margin-right:\s*auto/);
  });

  it('still wraps, or the two rules above have nothing to do', () => {
    /*
       `flex-wrap: wrap` is what creates the second line in the first place. Remove it and
       the meta stops wrapping, the bubble grows past its max-width, and both assertions
       above keep passing over a layout that is broken in a different way.
    */
    expect(ruleBody('.message-main')).toMatch(/flex-wrap:\s*wrap/);
  });
});
