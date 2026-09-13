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
 * ## The journey has a panel in the middle of it
 *
 * Picking one file opens `media-preview.tsx` — a modal that shows what was picked and takes
 * the caption. It covers the composer, so the send that finishes this journey is the
 * panel's, not the composer's. This spec drove the composer's until `836ae24` extended the
 * panel from pictures to documents; the send then sat behind a scrim and the test failed on
 * a timeout thirty seconds later, which is a slow way to be told the flow has a new step in
 * it.
 *
 * ## The defects this covers, in the order the person meets them
 *
 *   1. **Type first, then attach.** The composer's `send` callback omitted `staged` from
 *      its dependencies while `body` was in it, so typing rebuilt the closure and attaching
 *      afterwards did not. `readyIds` came from an empty `staged`, no `attachmentIds` were
 *      sent, and the chips were cleared regardless. Attaching before typing worked, which
 *      is why nobody hit it by hand. Still the order driven below, and now with the extra
 *      claim the panel makes: the line already typed IS the caption, one body and not two.
 *   2. **"Ready to send" meant "the bytes arrived".** §28.1 binds only a CLEAN attachment,
 *      so a file could be offered as ready, left out of the send, named in `notAttachedIds`
 *      — and that field was read by nothing. The interface's last word was that the
 *      document had been sent.
 *   3. **The optimistic row carried no attachments**, so a file that DID bind appeared only
 *      after a reload — indistinguishable, to the person who just sent it, from a drop.
 *
 * ## No arbitrary waits
 *
 * Every step below waits on something the person can see: a chip's own words, a message in
 * the thread, a control that arms. The one piece of staging is a HELD RESPONSE — the "I
 * finished uploading" call is answered by the real server, just not yet — which makes the
 * not-yet-sendable state last long enough to assert on without either side of the protocol
 * being faked. See the step that installs it.
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
  const panel = (): ReturnType<typeof employee.getByRole> =>
    employee.getByRole('dialog', { name: 'Send this file' });

  try {
    await startCustomerConversation(customer, 'I am sending you my claim documents.');
    await signIn(employee, 'agent');
    await claimFromQueue(employee);

    /**
     * The third of the four upload steps, held open until this spec has looked at the state
     * it produces.
     *
     * `markUploaded` runs the virus scan inside the request and answers CLEAN — measured at
     * about 96ms on the local stack — so "the bytes are up but the server will not bind this
     * yet" is real and lasts a fraction of a frame. Asserting on it unheld is a race the
     * product usually wins, which is a test that passes for the wrong reason.
     *
     * What is held is the RESPONSE, not the meaning. The request reaches the server
     * untouched, the server does the real work, and the real answer is what the client
     * eventually gets — the only thing this changes is when. That is the difference between
     * slowing a network and faking a protocol: an earlier attempt fulfilled this route with
     * an invented `SCANNING` body, which left the CHIP saying one thing and the SERVER
     * holding another, and the next assertion then waited for a refusal that correctly never
     * came.
     */
    let releaseUpload = (): void => {};
    const uploadHeld = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    await employee.route(/\/attachments\/[^/]+\/uploaded$/, async (route) => {
      await uploadHeld;
      await route.continue();
    });

    await test.step('the agent types, THEN attaches — the order that silently dropped the file', async () => {
      await employee.getByLabel('Reply to customer body').fill('Here is the assessor report.');

      await employee.getByLabel('Attach a file').setInputFiles({
        name: 'assessor-report.pdf',
        mimeType: 'application/pdf',
        buffer: PDF,
      });

      await expect(staged().getByText('assessor-report.pdf')).toBeVisible({ timeout: 30_000 });

      /* The panel opens on the file and carries the line already typed. The caption is the
         composer's own `body` — a second field with its own state would drift from it on
         exactly the things that matter, starting with the draft. */
      await expect(panel()).toBeVisible({ timeout: 30_000 });
      await expect(panel().getByLabel('Caption')).toHaveValue('Here is the assessor report.');
    });

    await test.step('while the server has not cleared it, the panel will not send it', async () => {
      /**
       * Defect 2, at the interface. §28.1 binds only a CLEAN attachment, so a send now
       * would put the sentence on the thread and leave the document behind — and the person
       * would have no way to know. The control is disabled and its label says which kind of
       * waiting this is, because "sending" and "not up yet" look identical on a greyed
       * arrow.
       */
      await expect(staged().getByText('uploading')).toBeVisible({ timeout: 30_000 });
      await expect(
        panel().getByRole('button', { name: 'Send when the file is ready' }),
        'the panel offered to send a file the server had not cleared',
      ).toBeDisabled();
    });

    await test.step('once the server has it, the send arms on its own', async () => {
      releaseUpload();

      /* Named 'Send' exactly — the label IS the readiness. There is no separate caption to
         wait for: the chip deliberately stopped saying "ready to send" once the check
         started finishing in milliseconds, and an armed control says it more usefully. */
      await expect(panel().getByRole('button', { name: 'Send', exact: true })).toBeEnabled({
        timeout: 60_000,
      });
    });

    await test.step('sending attaches it, and it appears WITHOUT a reload', async () => {
      const sendResponse = employee.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/messages$/.test(new URL(r.url()).pathname),
        { timeout: 30_000 },
      );
      await panel().getByRole('button', { name: 'Send', exact: true }).click();

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

      /* The panel leaves when its file does — it follows the staged file, and the file
         going is what a successful send looks like from inside it. */
      await expect(panel()).toHaveCount(0, { timeout: 30_000 });

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
        (response) =>
          /\/v1\/employee\/attachments\/[0-9a-f-]+$/.test(new URL(response.url()).pathname),
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

/**
 * NOT COVERED HERE, and recorded rather than quietly dropped: sending a message while a
 * file is still being checked, and being told the document did not go with it.
 *
 * §34 and invariant 9 — the text is never hostage to the file — and the composer still
 * implements it: `send()` binds only READY attachments, reports the rest, and the banner in
 * `composer.tsx` names them. What has no browser-reachable route to it is the GESTURE. One
 * attachment opens the panel, the panel's send is disabled until the file is clean, and its
 * only other exit discards the file. So there is no way, from a browser, to press send on a
 * message whose single attachment is mid-scan.
 *
 * That is a deliberate product decision (`media-preview.tsx` argues it: a message that
 * arrives without its picture is the worse failure) and it makes this particular journey
 * unreachable rather than broken. The rule underneath it is covered where it can be:
 * `packages/attachments/src/pipeline.test.ts` asserts binding refuses a file that is not
 * clean (`NOT_CLEAN_YET`), and `apps/api/src/attachment-flow.test.ts` walks the ladder
 * including that nothing is downloadable before it is bound (§28.1). What is lost is the
 * browser-level proof that the INTERFACE says so — the half a unit test cannot see. It comes
 * back the day two files can be staged at once, because the second one does not get a panel.
 */
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
    const panel = employee.getByRole('dialog', { name: 'Send this file' });
    const messages = employee.getByRole('list', { name: 'Messages' });

    await expect(staged.getByText('suspicious.pdf')).toBeVisible({ timeout: 30_000 });

    /**
     * The verdict's WORDS, not merely that an alert exists.
     *
     * Both surfaces render `role="alert"` for every FAILED state, including the one the
     * picker sets at its own 60-second deadline ("taking too long to check"). Asserting only
     * that an alert appeared — within a 60-second budget — would pass identically on a build
     * where the INFECTED verdict never arrived at all. What is under test is that the
     * scanner's answer reaches the person, so the text is the assertion.
     */
    await expect(panel.getByRole('alert')).toContainText('did not pass the virus check', {
      timeout: 60_000,
    });
    await expect(
      panel.getByRole('button', { name: /^Send/ }),
      'the panel offered to send a file that failed the virus check',
    ).toBeDisabled();

    // The chip behind the panel says the same thing, because the panel is not the only place
    // this file is shown and the two must not disagree.
    await expect(staged.getByText('did not pass the virus check')).toBeVisible();
    await expect(staged.getByRole('alert')).toBeVisible();
    await expect(
      staged.getByText('ready to send'),
      'a file that failed the scan must never be offered as sendable',
    ).toHaveCount(0);

    /**
     * And nothing anywhere tells the person to try the infected file again.
     *
     * The "kept back" banner reports files that were OFFERED to the server and refused. It
     * used to be computed from everything still staged, so an INFECTED chip — never offered,
     * and never bindable — produced "it is still being checked… send it again in a moment"
     * directly beside a chip saying it had failed the virus check. This journey drove that
     * case and asserted nothing about it, which is how the defect shipped inside the fix
     * that introduced it.
     */
    await expect(
      employee.getByText('It stays here; send it again'),
      'the composer is advising the person to re-send a file that failed the virus check',
    ).toHaveCount(0);

    /* The only way out of the panel with a file it will not send: drop the file. The typed
       line is NOT dropped with it — somebody who picked a bad document has not changed their
       mind about the sentence they wrote. */
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toHaveCount(0);
    await expect(employee.getByLabel('Reply to customer body')).toHaveValue('Received, thank you.');
    await expect(staged.getByText('suspicious.pdf')).toHaveCount(0);

    // The message still goes. The text is never hostage to the file (invariant 9).
    await employee.getByRole('button', { name: 'Send to customer' }).click();
    await expect(messages.getByText('Received, thank you.')).toBeVisible({ timeout: 30_000 });

    // And the infected file is not on the thread.
    await expect(messages.getByText('suspicious.pdf')).toHaveCount(0);
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});
