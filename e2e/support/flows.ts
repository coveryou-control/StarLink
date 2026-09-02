/**
 * The two entry points every browser test starts from.
 *
 * Shared rather than copied so the specs cannot drift apart: if the sign-in form or the
 * intake widget changes shape, exactly one place needs editing and every spec fails
 * together rather than one silently testing an older flow.
 *
 * Both drive the real forms. Neither injects a cookie or seeds a conversation directly —
 * a browser suite whose fixtures bypass the front door proves the front door works only
 * as long as nobody changes it.
 */
import { expect, type Page } from '@playwright/test';

import { CREDENTIALS, ORIGINS, TEAM_ID } from './env.js';
import { otpsIssued, uniqueMobile, waitForOtp } from './otp.js';

export async function signIn(page: Page, who: keyof typeof CREDENTIALS): Promise<void> {
  await page.goto(`${ORIGINS.employeeWeb}/sign-in`);
  /* The field is labelled "Work email" now, as the design labels it. The local IAM adapter
     takes the local part of an address, so a bare username still signs in — which is why
     the fixtures below did not have to grow a domain. */
  await page.getByLabel('Work email').fill(CREDENTIALS[who].username);
  await page.getByLabel('Password').fill(CREDENTIALS[who].password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/conversations/);
}

/**
 * A customer opens the widget, picks this suite's topic, proves a mobile number with a
 * real one-time code, and sends a first message.
 */
export async function startCustomerConversation(
  page: Page,
  firstMessage: string,
): Promise<{ mobile: string }> {
  const mobile = uniqueMobile();

  await page.goto(ORIGINS.customerWeb);
  await page.getByRole('button', { name: 'Chat with us' }).click();
  await verifyAndEnter(page, mobile);

  await page.getByLabel('Your message').fill(firstMessage);
  await page.getByRole('button', { name: 'Send' }).click();

  /**
   * Wait for the message to SETTLE, not merely to appear.
   *
   * `getByText(firstMessage)` matches the optimistic bubble the instant it is typed, so
   * this helper used to return before intake had committed anything — every caller then
   * built on a conversation that might not exist yet. `drafts-and-offline.spec.ts` duly
   * failed the moment customer requests got one round trip slower: it called
   * `setOffline(true)` while intake was still in flight, intake failed, and the FIRST
   * message ended up marked "⚠ Not sent" — a test failure that looks exactly like a
   * product bug and is not one.
   *
   * Settled is detected by the TIMESTAMP, not by the absence of a status word. The first
   * attempt filtered `hasNotText: 'Sending'`, which is matched as a case-insensitive
   * SUBSTRING — so a perfectly settled bubble reading "I am sending you my claim
   * documents." excluded itself, and `attachments.spec.ts` failed on a message that had
   * arrived. Any status-word filter has that hazard, because the words a person types are
   * not disjoint from the words the UI uses.
   *
   * A `time` element is rendered only once the server has a `createdAt` for the message.
   * The in-flight bubble shows "Sending" and the failed one "⚠ Not sent"; neither carries
   * a timestamp, so its presence is exactly the property "the server has this".
   */
  await expect(
    page.getByRole('listitem').filter({ hasText: firstMessage }).locator('time'),
    'the first message never settled — intake did not complete, so there is no conversation',
  ).toBeVisible({ timeout: 30_000 });

  // Returned so a test can come back as the SAME person: the conversation belongs to the
  // principal the proven number resolves to, and a different number is a different one.
  return { mobile };
}

/**
 * A note for anyone about to write "the customer comes back later".
 *
 * There is no such journey yet. `POST /v1/customer/auth/session` mints a NEW principal on
 * every visit, verification re-issues the cookie for that same new principal rather than
 * resolving one from the proven number, and `listForCustomer` scopes by the principal's
 * own participation — so a returning customer sees an empty widget, not their history.
 *
 * That is a product gap tied to the absent Customer Master (N-01/N-02), not a defect to
 * patch in a test helper: resolving a principal from a verified contact detail is exactly
 * the authority StarLink is forbidden to become (brief rule 11).
 */
async function verifyAndEnter(page: Page, mobile: string): Promise<void> {
  // Chosen by name: a leftover category from another suite must not silently route this
  // conversation to a team whose queue the test never looks at.
  await page.getByRole('radio', { name: /Browser Topic/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Mobile number').fill(mobile);

  // Counted BEFORE the request, so a customer verifying a second time is handed the second
  // code rather than the first one, which is already spent. See `otp.ts`.
  const alreadyIssued = otpsIssued(mobile);
  await page.getByRole('button', { name: 'Send code' }).click();

  // The real code, typed into the real field. `otp.ts` explains why it comes from the log.
  await page.getByLabel('Enter the code').fill(await waitForOtp(mobile, { after: alreadyIssued }));
  await page.getByRole('button', { name: 'Continue' }).click();
}

/**
 * Takes the oldest waiting conversation from this team's queue and opens it.
 *
 * The wait is generous because the row only appears once the routing sweep has run —
 * §23.3 queues an after-hours arrival rather than assigning it, which is what puts
 * anything in the queue at all.
 */
export async function claimFromQueue(page: Page): Promise<void> {
  const queue = page.getByRole('region', { name: `Queue for ${TEAM_ID}` });
  // `.first()` on the assertion as well as the click: a spec file that creates more than
  // one conversation legitimately has several waiting, and an unqualified locator then
  // trips strict mode on a queue that is simply doing its job.
  const take = queue.getByRole('button', { name: 'Take' }).first();
  await expect(take).toBeVisible({ timeout: 30_000 });
  await take.click();
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}/);
  await expect(page.getByRole('list', { name: 'Messages' })).toBeVisible();
}
