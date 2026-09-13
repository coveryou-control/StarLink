/**
 * Cropping a picture before it is sent, from a browser.
 *
 * ## Why this needs a browser at all
 *
 * The geometry is unit-tested in `image-edit.test.ts`, and that is where the maths belongs —
 * a square crop of a landscape photograph, a quarter turn swapping the sides, a rectangle
 * clamped back inside the picture. None of it needs a DOM.
 *
 * What a unit test cannot see is the part that actually breaks: whether the rectangle drawn
 * on the screen is the rectangle the canvas cuts. Those are connected by a chain of
 * conversions — pointer coordinates to the image's own box, fractions to percentages for
 * drawing, fractions to natural pixels for exporting — and every link is plausible on its
 * own. A crop tool with one of them wrong does not throw. It sends a clean picture of the
 * wrong part of the photograph, and the person who sent it has already looked at a preview
 * that agreed with them.
 *
 * So this drives the real editor over a real picture and asserts on the WIRE: the bytes
 * offered to the server after the edit are not the bytes offered before it, and the server
 * binds the new ones.
 */
import { deflateSync } from 'node:zlib';

import { expect, test, type Page } from '@playwright/test';

import { claimFromQueue, signIn, startCustomerConversation } from './support/flows.js';
import { resetTeamWork } from './support/reset.js';

/**
 * A real PNG, built here rather than committed as a fixture.
 *
 * The scanner sniffs content and refuses a mismatch (§28.2), so this has to be a genuine
 * PNG and not a renamed text file. Generating it keeps the bytes visible in the test that
 * depends on them — and makes the gradient deliberate: a flat colour would crop to something
 * identical to the original, which is the one picture that cannot prove a crop happened.
 */
function png(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = (x * 7) % 256;
      raw[at + 1] = (y * 11) % 256;
      raw[at + 2] = ((x + y) * 13) % 256;
    }
  }

  const table = [...Array(256).keys()].map((n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff;
    for (const value of bytes) c = table[(c ^ value) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, checksum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Every upload grant this page asks for, with the size it declared.
 *
 * The grant carries `declaredBytes`, so "a different file was staged" is a fact on the wire
 * rather than an inference from the interface. Collected from the request rather than the
 * response because the response does not echo it back.
 */
function watchGrants(page: Page): { readonly sizes: number[] } {
  const sizes: number[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (!/\/conversations\/[^/]+\/attachments$/.test(new URL(request.url()).pathname)) return;
    const body = request.postData();
    if (body === null) return;
    const declared = (JSON.parse(body) as { declaredBytes?: number }).declaredBytes;
    if (typeof declared === 'number') sizes.push(declared);
  });
  return { sizes };
}

test.beforeAll(async () => {
  await resetTeamWork();
});

test('an agent crops a picture before sending it, and the cropped one is what goes', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  try {
    await startCustomerConversation(customer, 'Photographs of the damage, please.');
    await signIn(employee, 'agent');
    await claimFromQueue(employee);

    const grants = watchGrants(employee);

    await test.step('the picture opens in the send panel, offering an edit', async () => {
      await employee.getByLabel('Attach a file').setInputFiles({
        name: 'damage.png',
        mimeType: 'image/png',
        buffer: png(400, 300),
      });

      const panel = employee.getByRole('dialog', { name: 'Send this file' });
      await expect(panel).toBeVisible({ timeout: 30_000 });
      /* The control exists for a PICTURE. A document reaches the same panel and must not be
         offered a crop box, which `attachments.spec.ts` covers by never finding one. */
      await expect(panel.getByRole('button', { name: 'Edit picture' })).toBeVisible();
    });

    await test.step('the editor opens with a crop rectangle over the picture', async () => {
      await employee
        .getByRole('dialog', { name: 'Send this file' })
        .getByRole('button', { name: 'Edit picture' })
        .click();

      await expect(employee.getByRole('button', { name: 'Apply' })).toBeVisible();
      await expect(employee.locator('.image-editor-crop')).toBeVisible();
      /* Four corners. A rectangle with three handles is a rectangle somebody cannot drag
         the way they expect, and it is the kind of thing a refactor drops silently. */
      await expect(employee.locator('.image-editor-handle')).toHaveCount(4);
    });

    await test.step('dragging a corner shrinks the rectangle', async () => {
      const crop = employee.locator('.image-editor-crop');
      const before = await crop.boundingBox();
      expect(before).not.toBeNull();

      /* The bottom-right handle, dragged up and left. Real pointer events rather than a
         synthetic one: the whole point of this test is the coordinate chain, and
         `dispatchEvent` would skip the part where the browser decides where the pointer is. */
      const handle = employee.locator('.image-editor-handle.is-se');
      const grip = await handle.boundingBox();
      expect(grip).not.toBeNull();

      await employee.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
      await employee.mouse.down();
      await employee.mouse.move(
        grip!.x + grip!.width / 2 - before!.width * 0.45,
        grip!.y + grip!.height / 2 - before!.height * 0.45,
        { steps: 12 },
      );
      await employee.mouse.up();

      const after = await crop.boundingBox();
      expect(after!.width, 'the crop rectangle did not follow the handle').toBeLessThan(
        before!.width * 0.8,
      );
      expect(after!.height).toBeLessThan(before!.height * 0.8);
    });

    await test.step('applying uploads a DIFFERENT file, and returns to the send panel', async () => {
      const beforeCount = grants.sizes.length;
      expect(beforeCount, 'the original was never uploaded').toBeGreaterThan(0);
      const original = grants.sizes[beforeCount - 1]!;

      await employee.getByRole('button', { name: 'Apply' }).click();

      /* Back on the send panel — the editor is a step, not a destination. */
      await expect(employee.getByRole('dialog', { name: 'Send this file' })).toBeVisible();
      await expect(employee.locator('.image-editor-crop')).toHaveCount(0);

      /* A second grant, for a file that is not the first one. This is the assertion the
         whole spec exists for: the canvas produced real, different bytes and they are what
         was offered to the server. */
      await expect
        .poll(() => grants.sizes.length, { timeout: 30_000 })
        .toBeGreaterThan(beforeCount);
      const edited = grants.sizes[grants.sizes.length - 1]!;
      expect(edited, 'the edited upload is byte-identical to the original').not.toBe(original);
    });

    await test.step('sending binds the edited picture', async () => {
      const panel = employee.getByRole('dialog', { name: 'Send this file' });
      await panel.getByLabel('Caption').fill('The dented panel, close up.');

      const sendResponse = employee.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/messages$/.test(new URL(r.url()).pathname),
        { timeout: 30_000 },
      );
      await panel.getByRole('button', { name: 'Send', exact: true }).click();

      const body = (await (await sendResponse).json()) as {
        attachedIds: string[];
        notAttachedIds: string[];
      };
      expect(
        body.attachedIds,
        `the server did not bind the edited picture. notAttachedIds: ${JSON.stringify(body.notAttachedIds)}`,
      ).toHaveLength(1);

      await expect(
        employee.getByRole('list', { name: 'Messages' }).getByText('The dented panel, close up.'),
      ).toBeVisible({ timeout: 30_000 });
    });
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});
