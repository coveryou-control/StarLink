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
     */
    const blocks = [...css.matchAll(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/g)];
    expect(blocks.length, 'expected exactly one local dark block').toBe(1);
    const declarations = [...(blocks[0]?.[1] ?? '').matchAll(/^\s*--[a-z0-9-]+:/gm)];
    expect(
      declarations.length,
      'the local dark block has grown into a second palette; it should only carry values ' +
        'the design system does not define',
    ).toBeLessThanOrEqual(8);
  });

  it('offers exactly the three choices the module can resolve', () => {
    // A fourth option in the panel with no branch in `applyTheme` is a button that does
    // nothing, which is the shape of the original bug.
    expect(panel).toContain("(['system', 'light', 'dark'] as const)");
  });
});
