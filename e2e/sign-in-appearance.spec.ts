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
 * ## What this asserts, and why it changed
 *
 * It used to assert the fields were LIGHT in either theme. That was the right test while
 * the screen had one palette; the screen has since been given a real dark mode, so
 * "light" stopped describing correct behaviour and started describing the old design.
 * A test that pins a design decision the product has deliberately moved past is not
 * protecting anything.
 *
 * What the original defect actually was: a field somebody could not see they were typing
 * into. That is CONTRAST between the field and its own text — a measurement that is
 * equally true of a light field on a light panel and a dark field on a dark one, and one
 * that still fails the exact bug this file was written for, where the box went near-black
 * while its text stayed dark.
 *
 * The second assertion is unchanged and is the one with teeth: the two fields must MATCH
 * each other. A fix that repainted the panel to suit a broken field would satisfy any
 * single-field check and still be the bug. Two controls that sit side by side and are
 * meant to be identical must actually be identical.
 */
import { expect, test } from '@playwright/test';

import { ORIGINS } from './support/env.js';
import { signIn } from './support/flows.js';

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

/**
 * WCAG contrast between two colours, so "can you see it" is a number.
 *
 * Replaces a bare lightness check. Lightness could only ever describe one theme; contrast
 * describes the property that actually matters in both, and it is what the original
 * defect violated — a near-black field still carrying dark text.
 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

for (const scheme of ['light', 'dark'] as const) {
  // `test.use` rather than a hand-rolled `browser.newContext({ colorScheme })`, so the page
  // still arrives with every option the project sets — trace, screenshot, device.
  //
  // The URL is absolute because this suite has no `baseURL` to be relative to: it drives
  // two separate web applications, so every spec names the origin it means.
  test.describe(`in a ${scheme} OS theme`, () => {
    test.use({ colorScheme: scheme });

    test('the sign-in fields stay readable and identical', async ({ page }) => {
      await page.goto(`${ORIGINS.employeeWeb}/sign-in`);

      /*
        Every field surface on the page, whatever the markup underneath.

        Both fields are wrappers now — the email box was made symmetric with the password
        box when the screen was redesigned, which is also what makes the original defect
        structurally impossible rather than merely fixed. Locating them by the class that
        DRAWS the surface, rather than by tag, means this keeps testing the thing it is
        about if the markup moves again.
      */
      const fields = page.locator('.signin-control');
      await expect(fields).toHaveCount(2);

      /* The surface AND the ink on it, because the question is whether the two work
         together — a light field is useless with light text, and the theme decides both. */
      const painted = await fields.evaluateAll((els) =>
        els.map((el) => {
          const style = getComputedStyle(el);
          /* The wrapper draws the surface; the ink is on the input inside it, and falls
             back to the wrapper's own colour where the markup is flat. */
          const input = el.querySelector('input');
          return {
            background: style.backgroundColor,
            ink: input === null ? style.color : getComputedStyle(input).color,
          };
        }),
      );

      /* 4.5:1 is WCAG AA for body text. The defect this file exists for — a field that
         went near-black while its text stayed dark — scores about 1.2 and fails here in
         either theme, which is the whole point of measuring contrast rather than
         lightness. */
      for (const { background, ink } of painted) {
        expect(
          contrast(background, ink),
          `a field is not readable in ${scheme}: ${ink} on ${background}`,
        ).toBeGreaterThan(4.5);
      }

      const backgrounds = painted.map((field) => field.background);

      // And the same as each other — the half-correct state is the one that hid for so long.
      expect(new Set(backgrounds).size, `the fields disagree in ${scheme}: ${backgrounds.join(' vs ')}`).toBe(1);
    });

    test('the screen is dark whatever the OS asked for', async ({ page }) => {
      /**
       * The front door has one palette, and this is the assertion that says so.
       *
       * The screen was given a real dark mode and then made dark unconditionally: it is a
       * composition rather than a surface somebody works in all day, and it is the same
       * composition for everybody. That is decided before the first paint in
       * `themeBootScript` — a component effect would be one frame too late and would show
       * a white flash on exactly the screen whose point is that it is not white.
       *
       * Asserted in BOTH OS themes from the same loop, because "dark by default" and "dark
       * because your laptop is" are different behaviours that look identical to anybody
       * testing on a dark machine.
       */
      await page.goto(`${ORIGINS.employeeWeb}/sign-in`);

      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

      /* And the ground is actually painted dark, not merely labelled. The attribute is what
         the stylesheet reads; this is what the person sees, and a token that stopped
         resolving would satisfy the first check and fail this one. */
      const ground = await page
        .locator('.signin')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(luminance(ground), `the sign-in ground is not dark in ${scheme}: ${ground}`).toBeLessThan(0.1);
    });
  });
}

/**
 * The other half of "dark sign-in": the workspace behind it is not.
 *
 * Signing in is a CLIENT-side navigation, so the pre-paint script that forced the door dark
 * does not run again. Without the workspace re-applying the stored choice on mount, the
 * palette of the front door leaks into the product and stays there until a hard reload —
 * which is exactly the kind of fault that survives review, because the developer who just
 * signed in sees the theme they expected and the person who opens a bookmark sees a
 * different one.
 *
 * Run in a DARK OS theme deliberately. In a light one the workspace would look correct
 * whether or not anything re-applied the choice, so the test would pass on a broken build.
 */
test.describe('after signing in', () => {
  test.use({ colorScheme: 'dark' });

  test('the workspace is light, though the door was dark', async ({ page }) => {
    await page.goto(`${ORIGINS.employeeWeb}/sign-in`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await signIn(page, 'agent');

    /* `toHaveAttribute` retries, which is what makes this safe against the mount effect
       landing a frame after the navigation resolves. */
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(luminance(ground), `the workspace is not light: ${ground}`).toBeGreaterThan(0.5);
  });
});

/**
 * Coming BACK to the door, without a reload.
 *
 * The mirror of the test above, and the half that was missing. Signing out is
 * `router.replace('/sign-in')` — a client-side navigation, so `themeBootScript` does not run
 * — and the sign-in page kept whatever palette the workspace was showing. Anybody who had
 * chosen Light saw a light sign-in screen, and a hard refresh corrected it, which is what
 * made it look intermittent rather than like a rule with a hole in it.
 *
 * The stored choice here is LIGHT on purpose. With dark stored, or on a dark OS, the page
 * would look right whether or not anything forced it — so the test would pass on the broken
 * build, which is the failure mode of every theme test.
 */
test.describe('coming back to sign-in', () => {
  /* A LIGHT OS as well, so nothing about this passing can be attributed to the machine. */
  test.use({ colorScheme: 'light' });

  test('the door is dark again, without a reload, for somebody who chose Light', async ({ page }) => {
    await page.goto(`${ORIGINS.employeeWeb}/sign-in`);
    await page.evaluate(() => window.localStorage.setItem('starlink.theme', 'light'));
    await page.reload();

    await signIn(page, 'agent');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    /* Sign out through the API and let the shell notice, which is the path the product
       takes: the session provider sees SIGNED_OUT and the layout replaces the route. No
       document load happens anywhere in that sequence. */
    await page.evaluate(async (api) => {
      await fetch(`${api}/v1/employee/auth/sign-out`, { method: 'POST', credentials: 'include' });
    }, ORIGINS.api);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForURL(/sign-in/, { timeout: 45_000 });

    await expect(
      page.locator('html'),
      'the sign-in screen kept the workspace palette — it must be dark whatever the person chose',
    ).toHaveAttribute('data-theme', 'dark');

    const ground = await page
      .locator('.signin')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(luminance(ground), `the sign-in ground is not dark: ${ground}`).toBeLessThan(0.1);

    /* And their preference was not quietly rewritten on the way through. */
    await expect(page.locator('html')).toHaveAttribute('data-theme-choice', 'light');
  });
});
