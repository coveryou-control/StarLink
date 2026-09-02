/**
 * Attaching a document, from a browser (ADR-012, §28.1–28.4, SL-054).
 *
 * ## Why this exists
 *
 * Every part of the attachment pipeline was built, guarded and covered end to end by API
 * tests — and it could not be used by a person. `SL_ADAPTER_OBJECT_STORAGE=local` was
 * aliased to the in-memory mock, whose upload grant is `memory://upload/…`; the client does
 * exactly what ADR-012 prescribes and fetches the grant URL directly, against a scheme no
 * browser implements. The API tests uploaded through a dev-only base64 endpoint no frontend
 * referenced, so they proved the pipeline and said nothing about the product.
 *
 * For a claims pilot the document IS the request, so this is the journey, not a detail.
 *
 * ## The three defects this covers, in the order the person meets them
 *
 *   1. **Type first, then attach.** The composer's `send` callback omitted `staged` from
 *      its dependencies while `body` was in it, so typing rebuilt the closure and attaching
 *      afterwards did not. `readyIds` came from an empty `staged`, no `attachmentIds` were
 *      sent, and the chips were cleared regardless. Attaching before typing worked, which
 *      is why nobody hit it by hand.
 *   2. **"Ready to send" meant "the bytes arrived".** §28.1 binds only a CLEAN attachment
 *      and the scan happens on a sweep, so a file could be offered as ready, left out of
 *      the send, named in `notAttachedIds` — and that field was read by nothing. The
 *      interface's last word was that the document had been sent.
 *   3. **The optimistic row carried no attachments**, so a file that DID bind appeared only
 *      after a reload — indistinguishable, to the person who just sent it, from a drop.
 *
 * ## No arbitrary waits
 *
 * Every step below waits on something the person can see: a chip's own words, a message in
 * the thread, an alert. The scan sweep is set to five seconds in `playwright.config.ts` so
 * that both SCANNING and READY are observable states rather than a race — that is server
 * configuration for the test environment, not a sleep in the test.
 */
import { expect, test } from '@playwright/test';

import { claimFromQueue, signIn, startCustomerConversation } from './support/flows.js';
import { resetTeamWork } from './support/reset.js';

/** A minimal well-formed PDF: the scanner sniffs content and rejects a mismatch. */
const PDF = Buffer.from('%PDF-1.7\nan assessor report\n%%EOF\n', 'utf8');

/**
 * EICAR — the industry-standard harmless string every scanner recognises as a detection.
 * Not malware; it exists precisely so this path can be exercised.
 */
const EICAR = Buffer.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  'utf8',
);

test.beforeAll(async () => {
  await resetTeamWork();
});

test('an agent attaches a document to a customer reply, and it is downloadable (SL-054)', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  /**
   * "Files to send" is the COMPOSER's list; "Attached files" is the list on a sent
   * message. They used to share the second name, which made this suite's locators match
   * the wrong one — a chip asserted gone was found again as a rendered attachment — and
   * made the two indistinguishable to a screen reader.
   */
  const staged = (): ReturnType<typeof employee.getByRole> =>
    employee.getByRole('list', { name: 'Files to send' });
  const messages = (): ReturnType<typeof employee.getByRole> =>
    employee.getByRole('list', { name: 'Messages' });

  try {
    await startCustomerConversation(customer, 'I am sending you my claim documents.');
    await signIn(employee, 'agent');
    await claimFromQueue(employee);

    await test.step('the agent types, THEN attaches — the order that silently dropped the file', async () => {
      await employee.getByLabel('Reply to customer body').fill('Here is the assessor report.');

      await employee.getByLabel('Attach a file').setInputFiles({
        name: 'assessor-report.pdf',
        mimeType: 'application/pdf',
        buffer: PDF,
      });

      await expect(staged().getByText('assessor-report.pdf')).toBeVisible({ timeout: 30_000 });
    });

    await test.step('the file says it is still being checked, not that it is ready', async () => {
      /**
       * The state that did not exist. Between "the bytes arrived" and "§28.1 will bind
       * this" there is a scan, and the interface used to skip straight past it.
       */
      await expect(staged().getByText('still being checked')).toBeVisible({ timeout: 30_000 });
      await expect(
        staged().getByText('ready to send'),
        'a file is not ready to send before it is CLEAN — §28.1 will refuse to bind it',
      ).toHaveCount(0);
    });

    await test.step('sending now sends the message and SAYS the file did not go with it', async () => {
      /**
       * §34 and invariant 9: the text is never hostage to the file, so the send proceeds.
       * What must not happen is the previous behaviour — the message goes, the chip
       * disappears, and nothing says the document was left behind.
       */
      await employee.getByRole('button', { name: 'Send to customer' }).click();

      await expect(messages().getByText('Here is the assessor report.')).toBeVisible();

      await expect(
        employee.getByRole('alert').filter({ hasText: 'was not attached' }),
        'the message was sent without the file and the interface did not say so',
      ).toBeVisible({ timeout: 30_000 });

      // And the file is KEPT, so the person can send it again without re-uploading.
      await expect(
        staged().getByText('assessor-report.pdf'),
        'the unsent file was discarded — the person would have to upload it again',
      ).toBeVisible();
    });

    await test.step('once the scan finishes, the same file becomes genuinely ready', async () => {
      // Waiting on the chip's own words, not on a timer.
      await expect(staged().getByText('ready to send')).toBeVisible({ timeout: 60_000 });
    });

    await test.step('sending again attaches it, and it appears WITHOUT a reload', async () => {
      await employee.getByLabel('Reply to customer body').fill('Attaching it properly this time.');

      const sendResponse = employee.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/messages$/.test(new URL(r.url()).pathname),
        { timeout: 30_000 },
      );
      await employee.getByRole('button', { name: 'Send to customer' }).click();

      // Asserted on the wire as well as on the screen: "the chip disappeared" and "the
      // server bound it" are different claims, and only one of them is the product working.
      const body = (await (await sendResponse).json()) as {
        attachedIds: string[];
        notAttachedIds: string[];
      };
      expect(
        body.attachedIds,
        `the server did not bind the file. notAttachedIds: ${JSON.stringify(body.notAttachedIds)}`,
      ).toHaveLength(1);

      /**
       * The optimistic row now carries what the SERVER confirmed it bound — not what the
       * client hoped. Before this it carried no attachments at all, so the document showed
       * up only after a reload.
       */
      await expect(messages().getByText('assessor-report.pdf')).toBeVisible({ timeout: 30_000 });

      // And the chip is gone, because this time it really was sent.
      await expect(staged().getByText('assessor-report.pdf')).toHaveCount(0);
    });

    await test.step('and the authoritative read agrees with what was shown', async () => {
      // The optimistic row is a claim; this is the server's answer to the same question.
      await employee.reload();
      await expect(messages().getByText('assessor-report.pdf')).toBeVisible({ timeout: 30_000 });
    });

    await test.step('opening it asks the API for a grant, without reporting a failure', async () => {
      /**
       * The download is `window.open(grantUrl)` against a response carrying
       * `Content-Disposition: attachment`, so Chrome opens a popup and immediately turns it
       * into a file download — the popup's URL and load state are both unreliable to assert
       * on. So: the grant request must be made and must succeed, and §34.4's "temporarily
       * unavailable" must not appear. The bytes themselves are compared in
       * `attachment-flow.test.ts`, which is where a byte-for-byte assertion belongs.
       */
      const grantRequest = employee.waitForResponse(
        (response) => /\/v1\/employee\/attachments\/[0-9a-f-]+$/.test(new URL(response.url()).pathname),
        { timeout: 30_000 },
      );

      await employee.getByRole('button', { name: /assessor-report\.pdf/ }).click();

      const response = await grantRequest;
      expect(
        response.status(),
        'the download grant was refused — §28.4 ran and said no, or the object is gone',
      ).toBe(200);
      expect(new URL((await response.json()).url, 'http://localhost').pathname).toMatch(
        /^\/v1\/dev\/objects\/download\//,
      );

      await expect(messages().getByRole('alert')).toHaveCount(0);
    });
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});

test('a file that fails the scan is never offered as sendable (§34.4)', async ({ browser }) => {
  /**
   * The terminal case, and the one where saying nothing would be worst: a document the
   * product will NEVER attach. §34.4 requires an explicit failure so "the user keeps their
   * message and can retry" — a chip that sat on "still being checked" for ever, or one that
   * quietly said "ready", would both be lies of a different shape.
   */
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  try {
    await startCustomerConversation(customer, 'Attaching something questionable.');
    await signIn(employee, 'agent');
    await claimFromQueue(employee);

    await employee.getByLabel('Reply to customer body').fill('Received, thank you.');
    await employee.getByLabel('Attach a file').setInputFiles({
      name: 'suspicious.pdf',
      mimeType: 'application/pdf',
      buffer: EICAR,
    });

    const staged = employee.getByRole('list', { name: 'Files to send' });
    await expect(staged.getByText('suspicious.pdf')).toBeVisible({ timeout: 30_000 });

    /**
     * The verdict's WORDS, not merely that an alert exists.
     *
     * `attachment-picker.tsx` renders `role="alert"` for every FAILED state, including the
     * one it sets at its own 60-second deadline ("taking too long to check"). Asserting
     * only that an alert appeared — within a 60-second budget — would pass identically on a
     * build where the INFECTED verdict never arrived at all. What is under test is that the
     * scanner's answer reaches the person, so the text is the assertion.
     */
    await expect(staged.getByText('did not pass the virus check')).toBeVisible({
      timeout: 60_000,
    });
    await expect(staged.getByRole('alert')).toBeVisible();
    await expect(
      staged.getByText('ready to send'),
      'a file that failed the scan must never be offered as sendable',
    ).toHaveCount(0);

    // The message still goes. The text is never hostage to the file (invariant 9).
    await employee.getByRole('button', { name: 'Send to customer' }).click();
    await expect(
      employee.getByRole('list', { name: 'Messages' }).getByText('Received, thank you.'),
    ).toBeVisible({ timeout: 30_000 });

    /**
     * And the composer does NOT tell the person to try the infected file again.
     *
     * The "kept back" banner reports files that were OFFERED to the server and refused.
     * It used to be computed from everything still staged, so an INFECTED chip — never
     * offered, and never bindable — produced "it is still being checked… send it again in a
     * moment" directly beside a chip saying it had failed the virus check. This journey
     * drove that case and asserted nothing about it, which is how the defect shipped
     * inside the fix that introduced it.
     */
    await expect(
      employee.getByText('It stays here; send it again'),
      'the composer is advising the person to re-send a file that failed the virus check',
    ).toHaveCount(0);

    // And the infected file is not on the thread.
    await expect(
      employee.getByRole('list', { name: 'Messages' }).getByText('suspicious.pdf'),
    ).toHaveCount(0);
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});
