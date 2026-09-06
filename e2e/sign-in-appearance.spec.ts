/**
 * The sign-in screen renders the same in either OS theme (NFR-ACC-1).
 *
 * ## Why this exists
 *
 * The screen states its own palette in literal hex — `--si-panel`, `--si-field`,
 * `--si-ink` — precisely so a dark OS cannot repaint half of it. That intent was written
 * down in `globals.css` and was, for three consecutive redesigns, untrue: the email field
 * painted itself near-black inside a white panel whenever the OS asked for dark.
 *
 * The cause is a specificity loss, not a missing rule. The design system styles every bare
 * text box:
 *
 *     input[type='text'], input[type='password'], select, textarea { background: var(--surface) }
 *
 * An attribute selector is (0,1,1); `.signin-control` is (0,1,0). So the design system won,
 * and `--surface` is near-black under a dark theme.
 *
 * It escaped notice because it hits exactly one of the two fields. The password box is a
 * transparent `input` inside a `.signin-control-group` wrapper, and `.signin-control-group
 * input` is (0,2,1) — already above the design system's rule — so the field beside it stayed
 * white and the page looked half-correct rather than obviously broken.
 *
 * ## What this asserts
 *
 * That both fields are light in dark mode, and that they MATCH each other. The second half
 * is what has teeth: a fix that darkens the panel to suit the black field would satisfy
 * "both light" by making both dark, and would still be the bug. Two controls that sit side
 * by side and are meant to be identical must actually be identical.
 */
import { expect, test } from '@playwright/test';

import { ORIGINS } from './support/env.js';

/** Relative luminance, so "light" is a measurement rather than a hex comparison. */
function luminance(colour: string): number {
  const parts = /rgba?\(([^)]+)\)/.exec(colour);
  expect(parts, `un-parseable colour: ${colour}`).not.toBeNull();
  const [r, g, b] = parts![1].split(',').map((n) => Number.parseFloat(n));
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

const backgroundOf = (colour: string): number => luminance(colour);

for (const scheme of ['light', 'dark'] as const) {
  // `test.use` rather than a hand-rolled `browser.newContext({ colorScheme })`, so the page
  // still arrives with every option the project sets — trace, screenshot, device.
  //
  // The URL is absolute because this suite has no `baseURL` to be relative to: it drives
  // two separate web applications, so every spec names the origin it means.
  test.describe(`in a ${scheme} OS theme`, () => {
    test.use({ colorScheme: scheme });

    test('the sign-in fields stay light and identical', async ({ page }) => {
      await page.goto(`${ORIGINS.employeeWeb}/sign-in`);

      // The email box is a bare `input.signin-control`; the password box is the wrapper
      // that draws the field, with a transparent input inside it. Both are "the field".
      const email = page.locator('input.signin-control');
      const password = page.locator('.signin-control-group');
      await expect(email).toBeVisible();
      await expect(password).toBeVisible();

      const emailBg = await email.evaluate((el) => getComputedStyle(el).backgroundColor);
      const passwordBg = await password.evaluate((el) => getComputedStyle(el).backgroundColor);

      // Light: a field somebody can see they are typing into. 0.7 is comfortably below
      // white (1.0) and far above the near-black `--surface` (~0.01) this used to inherit.
      expect(backgroundOf(emailBg), `email field in ${scheme}: ${emailBg}`).toBeGreaterThan(0.7);
      expect(
        backgroundOf(passwordBg),
        `password field in ${scheme}: ${passwordBg}`,
      ).toBeGreaterThan(0.7);

      // And the same as each other — the half-correct state is the one that hid for so long.
      expect(emailBg, `the two fields disagree in ${scheme}`).toBe(passwordBg);
    });
  });
}
