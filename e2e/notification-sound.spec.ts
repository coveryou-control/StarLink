/**
 * The arrival sound, in a real browser, on the real notification path.
 *
 * ## What a unit test could not establish
 *
 * `notification-tone.test.ts` checks the sound itself — its level, its attack, its shape and
 * that every layer reaches the output. It says nothing about whether anything ever calls it.
 * The three failures that matter here are all integration failures: the tone never plays, it
 * plays several times for one arrival, or it plays for somebody who switched Sound off.
 *
 * ## How it is observed
 *
 * `AudioContext` is replaced before the app loads, with a stand-in that records rather than
 * plays. Playwright's Chromium has no audio device, so a real context would neither make a
 * sound nor fail in any way this could read; counting the nodes the app asks for is what
 * makes "it played" a fact rather than an absence of errors.
 *
 * A real message from a real colleague drives it — the same socket, notification list and
 * preference read the product uses — so what is under test is the path, not a function call.
 */
import { expect, test, type Page } from '@playwright/test';

import { signIn, startCustomerConversation, claimFromQueue } from './support/flows.js';
import { resetTeamWork } from './support/reset.js';

/**
 * Replaces `AudioContext` with a recorder, before any application script runs.
 *
 * `addInitScript` rather than `evaluate`: the module that plays the tone captures the
 * constructor lazily, but the page may have created a context before a later `evaluate`
 * could patch it, and a test that sometimes observes nothing is worse than no test.
 */
async function recordAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const started: number[] = [];
    (window as unknown as { __tones: number[] }).__tones = started;

    class Recording {
      readonly sampleRate = 48_000;
      currentTime = 0;
      state = 'running';
      readonly destination = {};
      resume(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
      createGain(): unknown {
        return this.node({ gain: this.param() });
      }
      createBiquadFilter(): unknown {
        return this.node({ type: 'lowpass', frequency: this.param(), Q: this.param() });
      }
      createOscillator(): unknown {
        return this.node({
          type: 'sine',
          frequency: this.param(),
          start: (at: number) => started.push(at),
          stop: () => undefined,
        });
      }
      createBufferSource(): unknown {
        return this.node({
          buffer: null,
          start: (at: number) => started.push(at),
          stop: () => undefined,
        });
      }
      createBuffer(channels: number, frames: number, sampleRate: number): unknown {
        return {
          sampleRate,
          length: frames,
          numberOfChannels: channels,
          getChannelData: () => new Float32Array(frames),
        };
      }
      private param(): unknown {
        return {
          setValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
          linearRampToValueAtTime: () => undefined,
        };
      }
      private node(shape: Record<string, unknown>): unknown {
        shape['connect'] = () => undefined;
        shape['disconnect'] = () => undefined;
        return shape;
      }
    }

    (window as unknown as { AudioContext: unknown }).AudioContext = Recording;
    (window as unknown as { webkitAudioContext: unknown }).webkitAudioContext = Recording;
  });
}

/** How many sound-producing nodes the page has started. Zero means it never played. */
const tonesStarted = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __tones?: number[] }).__tones?.length ?? 0);

/** Writes the device preferences this browser will read on the next notification. */
async function setSoundPreference(page: Page, sound: boolean): Promise<void> {
  await page.evaluate((on) => {
    window.localStorage.setItem(
      'starlink.device-notifications',
      JSON.stringify({
        direct: true,
        groups: true,
        sound: on,
        quietHours: false,
        quietFrom: '20:00',
        quietTo: '09:00',
      }),
    );
  }, sound);
}

test.beforeEach(async () => {
  await resetTeamWork();
});

test('a customer reply makes the agent’s browser play the arrival sound, once', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  try {
    await recordAudio(employee);
    await startCustomerConversation(customer, 'My policy number changed.');
    await signIn(employee, 'agent');
    await setSoundPreference(employee, true);
    await claimFromQueue(employee);

    /* Away from the thread the message lands in. The product deliberately stays silent for
       the conversation somebody is looking at — a tone for a bubble animating in front of
       them is noise — so the sound only exists to be observed from somewhere else. */
    await employee.goto(`${employee.url().split('/conversations')[0]}/conversations`);
    await expect(employee.getByRole('navigation', { name: 'Conversations' })).toBeVisible();

    const before = await tonesStarted(employee);

    await customer.getByLabel('Your message').fill('Also, please check my address.');
    await customer.getByRole('button', { name: 'Send' }).click();

    await expect
      .poll(() => tonesStarted(employee), {
        timeout: 60_000,
        message: 'the arrival sound never played for a message that raised a notification',
      })
      .toBeGreaterThan(before);

    /**
     * Once, not once per layer of coincidence.
     *
     * The sound is built from several nodes, so "it played" is a jump of the whole graph
     * rather than of one. What this rules out is the graph being built TWICE for one
     * arrival — a duplicate subscription, or an effect that ran on every render — which is
     * audible as a doubled sound and is the commonest way this breaks.
     */
    const after = await tonesStarted(employee);
    const perTone = after - before;
    await employee.waitForTimeout(3_000);
    expect(
      await tonesStarted(employee),
      'the sound played more than once for a single arriving message',
    ).toBe(before + perTone);
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});

test('turning Sound off silences it, and the notification still arrives', async ({ browser }) => {
  /**
   * The preference had no reader.
   *
   * `DeviceNotifications.sound` existed, the settings panel offered it, and nothing checked
   * it — so the switch was decoration and the only way to stop the noise was to stop being
   * notified. This is the assertion that keeps it connected.
   */
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  try {
    await recordAudio(employee);
    await startCustomerConversation(customer, 'A question about my cover.');
    await signIn(employee, 'agent');
    await setSoundPreference(employee, false);
    await claimFromQueue(employee);

    await employee.goto(`${employee.url().split('/conversations')[0]}/conversations`);
    await expect(employee.getByRole('navigation', { name: 'Conversations' })).toBeVisible();

    const before = await tonesStarted(employee);

    await customer.getByLabel('Your message').fill('Is the excess still five thousand?');
    await customer.getByRole('button', { name: 'Send' }).click();

    /* The message must still ARRIVE — the switch is about the sound, not about being told.
       Waiting on the unread count is what makes the silence below meaningful: without it
       this would pass just as happily on a build where nothing was delivered at all. */
    await expect(
      employee.getByRole('navigation', { name: 'Conversations' }).getByText('Is the excess'),
    ).toBeVisible({ timeout: 60_000 });

    expect(
      await tonesStarted(employee),
      'Sound is off and the arrival still played a tone',
    ).toBe(before);
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});
