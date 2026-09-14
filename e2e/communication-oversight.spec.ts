/**
 * Communication Oversight, in a real browser.
 *
 * The administrator opens a colleague's private one-to-one from inside StarLink, reads it
 * with the product's own message list, and is offered nothing that would change it. The
 * ordinary employee is not offered the door at all.
 *
 * ## Why this cannot be a unit test
 *
 * Every part of this has a test of its own already — `admin-audit.test.ts` sweeps the
 * decisions, `oversight-journey.test.ts` drives the routes over HTTP, and the component
 * tests cover the renderer. What none of them can answer is the question the feature was
 * actually asked for: can somebody get from the sidebar to the conversation, and does what
 * they land on look like a record rather than a seat at the table. That is a question about
 * a rendered page, so it is asked of one.
 *
 * ## Two employees make the thread; the administrator never touches it
 *
 * The conversation is created through the real "New chat" panel by the agent, so nothing
 * here is seeded past the front door. The administrator arrives afterwards, from a separate
 * browser context, holding nothing but their own session.
 */
import { expect, test } from '@playwright/test';

import { signIn } from './support/flows.js';
import { resetTeamWork } from './support/reset.js';

const FIRST = 'The renewal file is ready for your signature.';

test.beforeEach(async () => {
  await resetTeamWork();
});

test('an administrator reads a colleague thread without being able to touch it', async ({
  browser,
}) => {
  const employeeContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const employee = await employeeContext.newPage();
  const admin = await adminContext.newPage();

  try {
    await test.step('two colleagues have a private conversation', async () => {
      await signIn(employee, 'agent');
      await employee
        .getByRole('button', { name: /^New (chat|conversation)$/ })
        .first()
        .click();
      const panel = employee.getByRole('region', { name: 'New chat' });
      await panel.getByPlaceholder(/name, department/i).fill('E2E Lead');
      await panel.getByRole('button', { name: /E2E Lead/ }).first().click();
      await expect(employee).toHaveURL(/\/conversations\/[0-9a-f-]{36}/, { timeout: 20_000 });

      /* `.first()`, because the message text is on screen more than once: the thread
         bubble, and the preview on the conversation's own row in the list beside it.
         Playwright's strict mode is right to refuse the ambiguous locator — the bubble is
         the first in document order and the one these steps are about. */
      await employee.getByRole('textbox', { name: /message/i }).first().fill(FIRST);
      await employee.keyboard.press('Enter');
      await expect(employee.getByText(FIRST).first()).toBeVisible({ timeout: 20_000 });
    });

    await test.step('the agent is not offered the oversight destination', async () => {
      /*
         The negative half, and it is not what protects anything — every route is decided
         again server-side, which `oversight-journey.test.ts` proves by asking as this very
         person. What this asserts is that the product does not advertise a capability this
         account does not hold.
      */
      await expect(employee.getByRole('button', { name: 'Oversight', exact: true })).toHaveCount(0);
    });

    await test.step('the administrator finds it from inside StarLink', async () => {
      await signIn(admin, 'administrator');

      /* A destination in the same shell, NOT a separate page. The URL must stay inside
         /conversations — an oversight that navigated away would be the thing this feature
         replaced. */
      await admin.getByRole('button', { name: 'Oversight', exact: true }).click();
      const panel = admin.getByRole('region', { name: 'Communication Oversight' });
      await expect(panel).toBeVisible();
      await expect(panel.getByText(/Read-only . every view is recorded/)).toBeVisible();

      /* The places to stand, with a real count on each — the structure that makes this an
         inbox rather than a filtered table. */
      await expect(panel.getByRole('button', { name: /^All conversations/ })).toBeVisible();
      await expect(panel.getByRole('button', { name: /^Direct chats/ })).toBeVisible();
      await expect(panel.getByRole('button', { name: /^Groups/ })).toBeVisible();

      /* Named after the people in it, which is the only thing that tells one untitled
         one-to-one from another. */
      const row = panel.getByRole('button', { name: /E2E Agent|E2E Lead/ }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.click();
      await expect(admin).toHaveURL(/\/conversations\/[0-9a-f-]{36}/, { timeout: 20_000 });
    });

    await test.step('what they get is the conversation, in the product own renderer', async () => {
      /* The real message, in the real list. A second transcript view is the thing this
         feature exists not to be. */
      await expect(admin.getByText(FIRST).first()).toBeVisible({ timeout: 20_000 });
    });

    await test.step('and it offers nothing that writes', async () => {
      /* Twice, and both earn their place: the badge answers "what am I looking at" while
         reading, and the strip answers "why is there nothing to type in". */
      await expect(
        admin.locator('.thread-oversight-badge'),
        'the header carried no read-only badge',
      ).toBeVisible();
      await expect(
        admin.getByText(/You are not in this conversation/),
        'the administrator was given no indication that this is an inspection',
      ).toBeVisible();

      /*
         Absent, not disabled. A disabled composer teaches somebody the product is broken;
         an absent one says this is a different job. The server refuses the send either way
         — `oversight-journey.test.ts` asserts that over HTTP.
      */
      await expect(
        admin.getByRole('textbox', { name: /message/i }),
        'a composer was offered on a conversation the administrator is not in',
      ).toHaveCount(0);

      /* The hover bar on a message is rendered only when the surface passes handlers for
         it, so its absence is the absence of reply, react and the message menu together. */
      await expect(admin.locator('.message-actions')).toHaveCount(0);
    });

    await test.step('the information panel answers the auditor question, not the member one', async () => {
      await admin
        .getByRole('button', { name: /details|information/i })
        .first()
        .click();

      /* Who was in it, with the authority each held and when they joined — which the
         member list cannot say, because it is a list of who is in it NOW. */
      await expect(admin.getByRole('heading', { name: 'Participants' })).toBeVisible({
        timeout: 20_000,
      });

      /* What the thread IS, which is the other half of an auditor's question. */
      await expect(admin.getByRole('heading', { name: 'About' })).toBeVisible();
      await expect(admin.getByText('Communication oversight · read-only')).toBeVisible();

      /* And none of the member panel's three writes. */
      await expect(admin.getByText('Add a colleague')).toHaveCount(0);
      await expect(admin.getByRole('button', { name: 'Leave group' })).toHaveCount(0);
    });

    await test.step('the participants conversation is exactly as they left it', async () => {
      /*
         The requirement in the product owner own words: inspection must not change unread
         counts, read receipts or conversation state. Proven precisely, over HTTP, in
         `oversight-journey.test.ts`; what a browser adds is that the AGENT's screen still
         works and still shows their own thread after somebody has been reading it.
      */
      await employee.reload();
      await expect(employee.getByText(FIRST).first()).toBeVisible({ timeout: 20_000 });
      await expect(
        employee.getByRole('textbox', { name: /message/i }).first(),
        'the participant lost their composer because somebody audited their thread',
      ).toBeVisible();
    });
  } finally {
    await employeeContext.close();
    await adminContext.close();
  }
});
