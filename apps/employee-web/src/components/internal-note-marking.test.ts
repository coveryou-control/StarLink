/**
 * Where the internal-note marking applies, and where it must not be dropped.
 *
 * ## The change this guards
 *
 * ADR-021 requires an internal note to carry four independent signals — border,
 * background, icon, persistent text label — so a customer-visible reply and a staff note
 * cannot be confused in the timeline they share.
 *
 * That timeline only exists on a customer conversation. In a colleague thread every
 * message is `INTERNAL` by construction, so a rule keyed on message visibility alone
 * matched all of them: the main screen of the product rendered as an unbroken column of
 * amber dashed boxes each captioned "NOT VISIBLE TO CUSTOMER", about a customer who is not
 * there. It also cost the thread its sent/received distinction, because the note styling
 * overrides `.mine`.
 *
 * So the marking is now gated on the conversation as well as the message. That is a
 * relaxation of a safety-adjacent rule, which is exactly the kind of change that gets
 * quietly widened later — hence this file.
 *
 * ## Why source-reading rather than rendering
 *
 * This surface has no DOM test harness, and the behavioural proof already exists and is
 * stronger than anything a unit test could add: `e2e/conversation-journey.spec.ts` drives
 * a real customer conversation in a browser and asserts the note is visible and captioned.
 * What that cannot see is the direction of the gate — a mistake that reads the predicate
 * the other way round would still mark the customer note and would ALSO mark nothing in an
 * internal thread, or worse, mark nothing anywhere. These assertions pin the direction.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const list = readFileSync(join(here, 'message-list.tsx'), 'utf8');
const thread = readFileSync(join(here, '..', 'app', 'conversations', '[id]', 'page.tsx'), 'utf8');
const composer = readFileSync(join(here, 'composer.tsx'), 'utf8');

describe('internal-note marking', () => {
  it('gates the note treatment on the conversation, not on visibility alone', () => {
    /**
     * Both halves matter. Without the conversation term the marking returns to every
     * message in every internal thread; without the visibility term it would mark every
     * message in a CUSTOMER conversation, including the ones the customer can read.
     */
    expect(
      /!conversationIsInternal && message\.visibility === 'INTERNAL'/.test(list),
      'the note predicate is not "an internal message in a customer conversation"',
    ).toBe(true);
  });

  it('applies the same predicate to the row, the flag, the quote and the pending row', () => {
    /**
     * Four call sites, and a partial change is worse than none: a row with the amber
     * ground and no caption, or a caption with no ground, is three of ADR-021's four
     * signals and reads as a rendering bug rather than as a warning.
     *
     * `isInternal` was the old name and must appear nowhere — its presence would mean one
     * of the four was missed.
     */
    expect(
      /\bconst isInternal\b/.test(list),
      'a bare visibility flag survives in message-list — one of the four call sites was missed',
    ).toBe(false);
    expect(list).toContain("className={`message-row${isCustomerNote ? ' internal' : ''}");
    expect(list).toContain('{isCustomerNote ? (');
    expect(list).toContain("!conversationIsInternal && repliedTo.visibility === 'INTERNAL'");
    expect(list).toContain("!conversationIsInternal && pending.visibility === 'INTERNAL'");
  });

  it('is fail-closed: an unresolved conversation kind keeps the marking', () => {
    /**
     * The prop asks "is this internal", so the unknown answer is `false` and the unknown
     * conversation is marked. Phrased the other way round — a `hasCustomer` prop — the
     * unknown case would DROP the warning, and the window in which the kind is unresolved
     * is exactly the first render of every thread.
     *
     * The page must therefore pass a POSITIVE test. `?.startsWith(…) === true` yields
     * `false` for an undefined type; `!type?.startsWith(…)` would yield `true`.
     */
    expect(
      /conversationIsInternal=\{conversationType\?\.startsWith\('INTERNAL'\) === true\}/.test(
        thread,
      ),
      'the thread page does not pass a positive, undefined-safe test for the conversation kind',
    ).toBe(true);
    expect(list).toContain('conversationIsInternal = false,');
  });

  it('keeps the composer on the same rule', () => {
    /**
     * The two components must agree. A composer that calls the next message a note while
     * the timeline above it calls the last one an ordinary message is a product telling
     * somebody two different things about one conversation.
     */
    expect(composer).toContain('const isCustomerNote = canReplyToCustomer && isInternal;');
  });

  it('still ships every ADR-021 signal for a real customer note', () => {
    /**
     * The positive control. Every assertion above is satisfied by deleting the marking
     * entirely, which is the failure this whole file exists to prevent.
     *
     * Border and background come from the stylesheet; the icon and the text label are
     * here.
     *
     * The CSS selector is `.message-row.internal .message-main`, not `.message-row.internal`.
     * The row became a flex layout with an avatar gutter, so the element that draws the
     * message — and therefore the one that must carry the amber and the dashed frame — is
     * the bubble inside it. This assertion moved with the property; it did not soften.
     */
    expect(list).toContain('INTERNAL — NOT VISIBLE TO CUSTOMER');
    expect(list, 'the lock icon — ADR-021 signal 3 — is gone').toContain('🔒');
    const css = readFileSync(join(here, '..', 'app', 'globals.css'), 'utf8');
    const rule = css.slice(css.indexOf('.message-row.internal .message-main {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body, 'the dashed frame — ADR-021 signal 1 — is gone').toMatch(
      /border:\s*2px dashed var\(--warn-border\)/,
    );
    expect(body, 'the amber ground — ADR-021 signal 2 — is gone').toMatch(
      /background:\s*var\(--warn-bg\)/,
    );
  });
});
