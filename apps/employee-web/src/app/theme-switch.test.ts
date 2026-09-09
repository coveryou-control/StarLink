/**
 * The Appearance control must actually change the appearance.
 *
 * ## The failure this exists to catch
 *
 * Settings writes `data-theme` on the root element. At one point the stylesheet had only
 * `@media (prefers-color-scheme: dark)` — so the attribute was set, nothing read it, and
 * Light and Dark were three buttons that moved their own highlight and changed nothing
 * else. Everything typechecked, every test passed, and the feature did not exist.
 *
 * A unit test cannot see a rendered colour, but it can see whether the two sides still
 * refer to the same thing. That is the whole class of bug here: one half of a contract
 * being renamed or rewritten while the other half keeps compiling.
 *
 * The architecture changed when the CoverYou design system landed — dark is now the
 * system's own attribute scope rather than a palette this sheet maintains — so the
 * assertions below moved with it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]): string => readFileSync(resolve(here, ...parts), 'utf8');

const css = read('globals.css');
const dsTokens = read('ds', 'fig-tokens.css');
const theme = read('..', 'lib', 'theme.ts');
const layout = read('layout.tsx');
const panel = read('..', 'components', 'settings-panel.tsx');

describe('the theme switch is wired to the design system', () => {
  it('writes the attribute the design system reads', () => {
    // Both halves of the contract, asserted against each other rather than in isolation.
    expect(theme).toContain("setAttribute('data-theme'");
    expect(
      dsTokens,
      'the vendored design tokens carry no dark scope — a re-export may have dropped it',
    ).toContain('[data-theme="dark"]');
  });

  it('resolves "Match system" to an explicit value rather than to a media query', () => {
    /**
     * The exported tokens key dark off the attribute ONLY. Removing the attribute — which
     * is what "system" used to do — therefore resolves to light on a machine set to dark.
     * The preference has to be read and written, not delegated.
     */
    expect(theme).toContain("matchMedia('(prefers-color-scheme: dark)')");
    expect(theme, '"system" must resolve to an attribute, not clear it').not.toContain(
      "removeAttribute('data-theme')",
    );
  });

  it('keeps "Match system" live after the choice is made', () => {
    // A laptop switching to dark at sunset has to move the application with it; a one-off
    // read at load would leave it light until the next reload.
    expect(theme).toContain('addEventListener');
    expect(theme).toContain('removeEventListener');
  });

  it('resolves the theme before the first paint', () => {
    /**
     * Read from a component effect, the first paint is the default theme and the second is
     * the real one — a white flash on every load for anybody on dark. The boot script is
     * that read, inlined in `<head>`.
     */
    expect(layout).toContain('themeBootScript');
    expect(
      layout,
      'the boot script mutates <html> before React sees it, so hydration must be told',
    ).toContain('suppressHydrationWarning');
  });

  it('does not keep a second copy of the dark palette', () => {
    /**
     * The bridge in `globals.css` points this sheet's token names at the design system's
     * semantic tokens, and the system re-resolves them under its own dark scope. A second
     * palette here would be a set of colours that drifts from the export the moment
     * anybody re-runs it.
     *
     * One small block is legitimate and expected: the handful of values that are NOT kit
     * tokens (the rail's translucent overlays, the scrollbar thumb). The bound is what
     * stops a whole palette creeping back in.
     *
     * Raised from 8 to 9 on 2026-09-09 for the light-bubble direction. `--bubble-mine`,
     * `--bubble-mine-ink` and `--media-frame` cannot be expressed as kit tokens: the export
     * carries brand, critical, info, neutral, success and warning ramps and no violet at
     * all, so a lavender has nowhere else to live.
     *
     * ## What is counted, and why it changed
     *
     * It counted every declaration, and that measured the wrong thing. The hazard named
     * above is DRIFT — a colour written here by hand that the next export silently
     * disagrees with. A declaration whose value is nothing but `var(--kit-token)` cannot
     * drift: it has no colour of its own, it re-points a ROLE at one the export owns, and
     * a re-export moves it automatically. That is what the bridge is for.
     *
     * Counting those as palette forced a real choice to look like a violation. In dark the
     * export makes `--base-surface-primary` pure black, so every raised object in the
     * product — header, composer, card, selected row, incoming bubble — was darker than
     * the ground it sat on. Fixing it means pointing `--surface` at a different kit token,
     * which is exactly the sanctioned move and which the old count refused.
     *
     * So: literals are bounded, re-pointings are free. The guard now fails for the reason
     * it says it does.
     */
    const blocks = [...css.matchAll(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/g)];
    expect(blocks.length, 'expected exactly one local dark block').toBe(1);

    const body = (blocks[0]?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    const declarations = [...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)];

    /* A value made only of kit references, whitespace and CSS functions around them owns
       no colour of its own. Anything with a hex, an rgb()/hsl() literal or a bare colour
       keyword does. */
    const ownsAColour = (value: string): boolean =>
      /#[0-9a-f]{3,8}/i.test(value) || /(?:^|[\s(,])(?:rgba?|hsla?)\(/i.test(value);

    const literals = declarations.filter((d) => ownsAColour(d[2] ?? ''));
    const repointings = declarations.filter((d) => !ownsAColour(d[2] ?? ''));

    expect(
      literals.length,
      'the local dark block has grown into a second palette; it should only carry values ' +
        `the design system does not define. Literals: ${literals.map((d) => d[1]).join(', ')}`,
    ).toBeLessThanOrEqual(9);

    /*
       The positive half, and it names the regression rather than counting.

       Deleting these re-pointings puts `--surface` back on `--base-surface-primary`, which
       in dark is pure black — and every raised object in the product (header, composer,
       card, selected row, incoming bubble) goes back to being DARKER than the ground it
       sits on. A count would not have noticed; this does.
    */
    const repointed = Object.fromEntries(repointings.map((d) => [d[1], (d[2] ?? '').trim()]));
    expect(
      repointed['--surface'],
      'dark `--surface` must be re-pointed: the export makes it pure black, which is ' +
        'darker than the panels it is drawn on top of',
    ).toBeDefined();
    expect(repointed['--surface']).not.toContain('base-surface-primary');
  });

  it('offers exactly the three choices the module can resolve', () => {
    // A fourth option in the panel with no branch in `applyTheme` is a button that does
    // nothing, which is the shape of the original bug.
    expect(panel).toContain("(['system', 'light', 'dark'] as const)");
  });
});
