/**
 * Mobile and tablet usability (SL-013 — NFR-MOB-1, NFR-MOB-2, NFR-MOB-4).
 *
 * NFR-MOB-4 is the one that can be asserted mechanically rather than judged:
 * *"No horizontal scrolling of primary content at common widths."* A page whose document
 * is wider than its viewport is failing it, whatever it looks like in a screenshot.
 *
 * The employee shell used to fail this outright. Its grid was `minmax(240px, 320px) 1fr`
 * at every width, so on a 375px phone the sidebar took 240px and the conversation was
 * pushed off the side of the document — NFR-MOB-1's "field staff are not desk-bound" was
 * not merely cramped, it was unusable.
 *
 * The widths are the ones real devices use: a small phone, a large phone and a tablet.
 */
import { expect, test, type Page } from '@playwright/test';

import { claimFromQueue, signIn, startCustomerConversation } from './support/flows.js';
import { resetTeamWork } from './support/reset.js';

const WIDTHS = [
  { name: 'small phone', width: 375, height: 667 },
  { name: 'large phone', width: 414, height: 896 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

/**
 * The conversation pane must be worth reading on a phone.
 *
 * This is the assertion that has teeth. A grid of `minmax(240px, 320px) 1fr` does NOT
 * overflow at 375px - `1fr` simply collapses - so a no-sideways-scroll check passes while
 * the thread is squeezed into 135px beside a 240px sidebar. NFR-MOB-1 asks for a surface
 * that is *usable* on a phone, and 135px of message column is not.
 *
 * Below the breakpoint the sidebar stacks above the thread, so the pane gets the full
 * width. Asserting that is what makes this test fail if the breakpoint is removed.
 */
async function assertReadableMainPane(page: Page, where: string): Promise<void> {
  const box = await page.locator('main').boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${where}: no main pane`).not.toBeNull();
  expect(viewport, `${where}: no viewport`).not.toBeNull();
  const share = (box?.width ?? 0) / (viewport?.width ?? 1);
  expect(
    share,
    `${where}: the conversation pane is ${Math.round(share * 100)}% of the screen ` +
      `(${Math.round(box?.width ?? 0)}px of ${viewport?.width}px)`,
  ).toBeGreaterThan(0.9);
}

/** The document must never be wider than the window it is being read in. */
async function assertNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(
    overflow.scrollWidth,
    `${where}: the document scrolls sideways (${overflow.scrollWidth}px in ${overflow.clientWidth}px)`,
    // One pixel of tolerance for sub-pixel rounding; anything real is far larger.
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/**
 * The queue is shared, and claiming takes the OLDEST waiting entry (§23.4).
 *
 * Per test rather than per file: every test here creates the conversation it then claims,
 * so a leftover from the previous test is the one that gets taken - which is how a test
 * ends up asserting against a thread it never wrote to. Cheap, and it removes the whole
 * class of ordering bug rather than the instance that happened to surface.
 */
test.beforeEach(async () => {
  await resetTeamWork();
});

test('the employee surface is usable at phone and tablet widths (NFR-MOB-1, NFR-MOB-4)', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();

  let conversationUrl: string | undefined;

  try {
    // A real conversation, so the thread, the queue and the load panel are all rendered -
    // an empty shell would prove nothing about the widest content on the screen.
    await startCustomerConversation(customer, 'Checking my premium on a phone.');

    for (const size of WIDTHS) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
      const employee = await context.newPage();
      try {
        await signIn(employee, 'agent');
        await assertNoSidewaysScroll(employee, `${size.name} · conversation list`);

        /*
           The controls a phone user actually needs must be reachable, not merely present.

           Named by class rather than by role, because screen 08 draws TWO ways to compose
           on a phone — one in the masthead and the floating one — and they carry the same
           accessible name because they are the same action. The floating one is the
           assertion that matters here: it is the thumb-reachable control, and it is the one
           that sits above the bottom nav where a mis-set `bottom` would put it off-screen.
        */
        await expect(employee.locator('.fab-new')).toBeVisible();
        await expect(employee.getByRole('region', { name: /^Queue for/ })).toBeVisible();

        if (conversationUrl === undefined) {
          await claimFromQueue(employee);
          conversationUrl = employee.url();
        } else {
          // Straight to the conversation this agent already owns: each width is a fresh
          // context, and re-deriving the link from the list adds nothing to what is
          // being measured here.
          await employee.goto(conversationUrl);
          await expect(employee.getByRole('list', { name: 'Messages' })).toBeVisible({ timeout: 20_000 });
        }
        await assertNoSidewaysScroll(employee, `${size.name} · open conversation`);
        await assertReadableMainPane(employee, `${size.name} · open conversation`);
        await expect(employee.getByRole('list', { name: 'Messages' })).toBeVisible();
        await expect(employee.getByLabel('Reply to customer body')).toBeVisible();
      } finally {
        await context.close();
      }
      // Only the first width claims from the queue; the later ones open the conversation
      // this agent now owns, which is the state a returning phone user is actually in.
    }
  } finally {
    await customerContext.close();
  }
});

test('the customer widget is mobile-first (NFR-MOB-2, NFR-MOB-4)', async ({ browser }) => {
  for (const size of WIDTHS) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    const page = await context.newPage();
    try {
      await startCustomerConversation(page, `Reading this on a ${size.name}.`);
      await assertNoSidewaysScroll(page, `${size.name} · customer chat`);
      // The composer is the whole point of the surface; it must be usable, not clipped.
      await expect(page.getByLabel('Your message')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    } finally {
      await context.close();
    }
  }
});
