/**
 * A customer replying after their conversation was resolved and the reopen window passed
 * (BR-22, §21.4, §22.4).
 *
 * ## The defect
 *
 * BR-22 continues the customer on a NEW conversation against the same case, and the API
 * returns that id precisely so the widget can follow it — the handler says so: *"the widget
 * follows the id it is given rather than the one it sent."* The client's declared response
 * type omitted `conversationId`, so it refreshed the conversation it had SENT to, which the
 * message is not in. The customer watched their own words disappear, with no error, on the
 * one surface where that is least acceptable.
 *
 * It then got worse: the fork clears `resolved_at` on the shared case, so a second attempt
 * sent to the old id no longer looks past-window — `decideReopen` answers STILL_OPEN and the
 * message is written INTO the resolved conversation, which nobody is working and which no
 * queue contains. One customer, two threads, and a message filed where no one will see it.
 *
 * ## Why the browser, and what stands in for a reload
 *
 * `reopen-flow.test.ts` proves the API forks correctly and returns the right id; it cannot
 * see that the client ignores it. That gap is why this runs in a browser.
 *
 * The obvious second half would be a reload: the optimistic bubble is removed on success,
 * so "still visible" immediately afterwards only proves the server answered, and reloading
 * would ask the server what the customer actually has. **This spec does not reload, and an
 * earlier version of its title and this header said it did.**
 *
 * It does not because it cannot. There is no returning-customer journey to reload into:
 * `startSession` mints a NEW principal on every visit, so a reloaded widget is a different
 * customer looking at nothing, not the same customer looking again. Restoring a session
 * across a reload is N-01/N-02 and unbuilt.
 *
 * What stands in for it is the poll. The widget re-reads its conversation every 8 seconds
 * from the server, so waiting past one full cycle asks the same question a reload would —
 * "what does the server say this customer has" — through the mechanism that exists. It is
 * strictly weaker in one way (the client keeps its in-memory id rather than re-deriving
 * it) and that is precisely the defect's mechanism, so it is the right instrument here.
 *
 * §21.4's last transition row is "No — it simply continues", so nothing here asserts that
 * the customer is TOLD about the fork. They must not be.
 */
import { expect, test } from '@playwright/test';

import { CATEGORY_ID } from './support/env.js';
import { startCustomerConversation } from './support/flows.js';
import { connect } from './support/seed.js';
import { resetTeamWork } from './support/reset.js';

/** Comfortably past the seven-day default, so `decideReopen` must choose BR-22. */
const LONG_AGO_DAYS = 30;

test.beforeAll(async () => {
  await resetTeamWork();
});

test('a reply after the reopen window stays visible, and survives the next poll (BR-22)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const customer = await context.newPage();
  const pool = await connect();

  const FIRST = 'My claim was settled, thank you.';
  const AFTER_WINDOW = 'Sorry to come back — one more question about it.';

  try {
    await startCustomerConversation(customer, FIRST);

    /**
     * Resolve it and age it out, directly.
     *
     * Done in SQL rather than through the agent UI because what is under test is the
     * customer's next reply, not the resolve journey — `employee-actions.spec.ts` covers
     * that — and because the window is seven days, which no test can wait for.
     */
    const original = await test.step('the conversation is resolved, long ago', async () => {
      // Found by this suite's category rather than by message text: the body is the one
      // thing a projection or a trim could legitimately change, and a fixture lookup that
      // breaks for a cosmetic reason is a test that fails for the wrong reason.
      const row = await pool.query<{ conversation_id: string; case_id: string }>(
        `SELECT c.conversation_id, c.case_id
           FROM conversation.conversations c
           JOIN conversation.service_cases sc ON sc.case_id = c.case_id
          WHERE sc.category_id = $1
          ORDER BY c.created_at DESC
          LIMIT 1`,
        [CATEGORY_ID],
      );
      const conversationId = row.rows[0]?.conversation_id;
      expect(conversationId, 'the intake conversation was not found').toBeDefined();

      const resolvedAt = new Date(Date.now() - LONG_AGO_DAYS * 24 * 3600 * 1000).toISOString();
      await pool.query(
        `UPDATE conversation.conversations SET state = 'RESOLVED' WHERE conversation_id = $1`,
        [conversationId],
      );
      await pool.query(
        `UPDATE conversation.service_cases
            SET state = 'RESOLVED', resolved_at = $2, outcome_code = 'ANSWERED'
          WHERE case_id = $1`,
        [row.rows[0]?.case_id, resolvedAt],
      );
      return conversationId as string;
    });

    await test.step('the customer replies, and their message stays on screen', async () => {
      await customer.getByLabel('Your message').fill(AFTER_WINDOW);
      await customer.getByRole('button', { name: 'Send' }).click();

      /**
       * `hasNotText: 'Sending'` is what makes this meaningful: the optimistic bubble
       * appears instantly and would satisfy a plain visibility check even if the send
       * landed somewhere the widget cannot see. This waits for the settled row.
       */
      await expect(
        customer.getByRole('listitem').filter({ hasText: AFTER_WINDOW }).filter({ hasNotText: 'Sending' }),
        'the reply vanished — the widget refreshed the conversation it sent to, not the one ' +
          'the server wrote to',
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step('the server really did fork, so this is the BR-22 path', async () => {
      // Without this the test would also pass if the reply had simply reopened the old
      // thread, which is BR-21 and a different rule.
      const written = await pool.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM conversation.messages WHERE body = $1`,
        [AFTER_WINDOW],
      );
      expect(written.rowCount, 'the reply was not written at all').toBe(1);
      expect(
        written.rows[0]?.conversation_id,
        'the reply landed in the original conversation — no fork happened',
      ).not.toBe(original);
    });

    await test.step('it survives the next poll — the widget is on the fork, not the old thread', async () => {
      /**
       * The discriminating assertion, and the reason this test is in a browser at all.
       *
       * The widget re-reads its conversation every 8 seconds. With the defect, the client's
       * `conversation` still pointed at the ORIGINAL id, so the very next poll replaced the
       * thread with one the message is not in and the customer's words disappeared a few
       * seconds after they were typed — the optimistic bubble having already been cleared
       * on success.
       *
       * Waiting past a full poll cycle is therefore not padding: it is the difference
       * between "the server accepted it" and "the client is looking at the right
       * conversation".
       */
      await expect(customer.getByText(AFTER_WINDOW)).toBeVisible();
      await customer.waitForTimeout(10_000);
      await expect(
        customer.getByText(AFTER_WINDOW),
        'the message disappeared on the next poll — the widget never followed the fork',
      ).toBeVisible();
    });

    await test.step('and the NEXT reply goes to the fork too, not into the resolved thread', async () => {
      /**
       * The worse half of the defect. Because `forkConversation` clears `resolved_at` on
       * the shared case, a second message sent to the OLD id no longer looks past-window:
       * `decideReopen` answers STILL_OPEN and writes it into the conversation that is
       * RESOLVED, owned by nobody and in no queue. The customer believes they are in a
       * conversation; nobody is reading it.
       */
      const SECOND = 'And one last thing while I have you.';
      await customer.getByLabel('Your message').fill(SECOND);
      await customer.getByRole('button', { name: 'Send' }).click();
      await expect(
        customer.getByRole('listitem').filter({ hasText: SECOND }).filter({ hasNotText: 'Sending' }),
      ).toBeVisible({ timeout: 30_000 });

      const landed = await pool.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM conversation.messages WHERE body = ANY($1::text[])`,
        [[AFTER_WINDOW, SECOND]],
      );
      expect(landed.rowCount).toBe(2);
      const distinct = new Set(landed.rows.map((r) => r.conversation_id));
      expect(distinct.size, 'the two replies were split across two conversations').toBe(1);
      expect(
        [...distinct][0],
        'a reply was filed into the resolved conversation nobody is working',
      ).not.toBe(original);
    });

    await test.step('the customer is told nothing about the fork (§21.4)', async () => {
      /**
       * "No — it simply continues." The split exists so the organisation can measure two
       * pieces of work; announcing it would leak an internal boundary and invite a question
       * nobody needs to answer.
       *
       * Scoped to the widget rather than the document: `body` text includes Next's inlined
       * bootstrap scripts, which mention `window` for reasons that have nothing to do with
       * a reopen window. Scanning those made this assert about the framework.
       */
      const panel =
        (await customer.getByRole('region', { name: /Chat with/ }).textContent()) ?? '';
      for (const forbidden of ['reopen', 'new conversation', 'reopen window', 'expired', 'forked']) {
        expect(panel.toLowerCase(), `the widget mentioned "${forbidden}"`).not.toContain(forbidden);
      }
    });
  } finally {
    await pool.end().catch(() => undefined);
    await context.close();
  }
});
