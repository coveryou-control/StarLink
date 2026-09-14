'use client';

/**
 * Applying the appearance choice.
 *
 * ## Why "Match system" resolves to an explicit attribute
 *
 * The CoverYou design system ships its dark palette as `:root[data-theme="dark"]` — an
 * attribute scope, with no `prefers-color-scheme` rule anywhere in the export. That is the
 * right shape for a design system, because a media query would decide the question for
 * every consumer, and it means the browser's own preference reaches nothing on its own.
 *
 * There are two ways to bridge that, and only one of them is honest:
 *
 *   * Restate the 377 lines of exported dark tokens under `prefers-color-scheme` as well.
 *     That is a second copy of a generated file, and it drifts the first time somebody
 *     re-exports the design.
 *   * Resolve the preference here and write the attribute the design system already reads.
 *
 * So "Match system" is not an absence of a choice — it is a live subscription to the
 * machine's. `matchMedia` is read on load and listened to afterwards, so a laptop switching
 * to dark at sunset changes the application without a reload, which is the behaviour a
 * media query would have given for free and the reason it looked like the better option.
 *
 * ## Why this runs before React
 *
 * `RuntimeOriginsScript` already injects into `<head>`, and the same trick applies: reading
 * the stored choice from a component effect means the first paint is the default theme and
 * the second is the real one, which is a white flash on every load for anybody on dark.
 * `themeBootScript` is that read, inlined, running before the body renders.
 *
 * It also forces dark on the sign-in route, which is why the override lives in the script
 * rather than in the sign-in component: a component can only set the attribute in an
 * effect, which is one paint too late and is a white flash on the one screen whose whole
 * point is that it is dark. `data-theme-choice` still carries the person's real choice, so
 * nothing downstream mistakes the front door for a preference.
 */

/**
 * Where the choice is remembered.
 *
 * Exported because three places now read it — this module, the settings panel and the
 * sidebar's shortcut — and a fourth copy of the literal is how two of them end up writing
 * to different keys and silently disagreeing about the theme.
 */
export const THEME_KEY = 'starlink.theme';

export type Theme = 'system' | 'light' | 'dark';

/**
 * What the workspace looks like to somebody who has never opened Settings.
 *
 * It was "match system", which is the defensible default in the abstract and was not what
 * this product wanted: the workspace is a light interface, and a colleague on a dark laptop
 * met a dark one on their first visit without having asked for it. "Match system" is still
 * one of the three choices and still live — see `watchSystemTheme` — it is simply no longer
 * the one nobody picked.
 *
 * The trade this makes is real and is worth naming: a machine set to dark for a reason —
 * including an accessibility reason — no longer carries that into this application until
 * its owner says so in Settings.
 */
export const DEFAULT_THEME: Theme = 'light';

/**
 * The route that ignores all of this.
 *
 * Sign-in is a designed screen with one palette, the way most products' front doors are: it
 * is dark, in either OS theme and whatever the stored choice says, because it is a
 * composition rather than a surface somebody works in all day. The workspace behind it is
 * the opposite and takes the choice.
 */
export const SIGN_IN_PATH = '/sign-in';

/**
 * The remembered choice, or the default.
 *
 * Reads defensively for the same reason the boot script does: a browser with site data
 * blocked throws on `localStorage`, and an appearance preference is not worth a blank page.
 */
export function storedTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Force the front door dark, and give back a way to undo it.
 *
 * ## Why the boot script is not enough
 *
 * `themeBootScript` stamps dark on `/sign-in` before the first paint, and that covers
 * somebody opening the address or reloading. It does NOT cover arriving here from inside
 * the application: signing out is `router.replace('/sign-in')`, a client-side navigation,
 * so no document loads and no script runs. The page then keeps whatever the workspace was
 * showing — light, for anybody who chose light — and a hard refresh "fixed" it, which is
 * exactly the shape of a bug that gets reported as intermittent.
 *
 * This is the same failure the workspace had in the other direction, where the door's dark
 * leaked inward until `conversations/layout.tsx` re-applied the stored choice on mount. Both
 * halves of one rule: a route that cares about the theme has to assert it on mount, because
 * a client-side navigation changes the page without reloading the document.
 *
 * ## `data-theme-choice` is deliberately untouched
 *
 * The person's preference is not being changed, and must not appear to have been: they are
 * looking at a screen that has one palette. Settings still reads their real choice, and
 * `restore()` puts the resolved attribute back when this page goes away.
 */
export function forceSignInTheme(): () => void {
  const root = document.documentElement;
  root.setAttribute('data-theme', 'dark');
  return () => applyTheme(storedTheme());
}

/** Resolves a choice to the attribute the design system reads. */
export function applyTheme(choice: Theme): void {
  const root = document.documentElement;
  const resolved =
    choice === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : choice;
  root.setAttribute('data-theme', resolved);
  // The CHOICE, kept beside the resolved value: the settings panel needs to know that
  // "system" was picked, which the resolved attribute alone cannot say.
  root.setAttribute('data-theme-choice', choice);
}

/**
 * Keeps "Match system" live.
 *
 * Returns its own unsubscribe. Called once from the shell rather than from the settings
 * panel, because the preference has to keep working while Settings is closed — which is
 * almost always.
 */
export function watchSystemTheme(): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (): void => {
    if (document.documentElement.getAttribute('data-theme-choice') !== 'system') return;
    applyTheme('system');
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * The pre-paint read, as a string for an inline `<script>`.
 *
 * Deliberately tiny and deliberately defensive: it runs before anything else on the page,
 * so a throw here is a blank document. A browser with site data blocked falls through to
 * the system preference, which is the right default and not an error.
 */
export const themeBootScript = `(function(){try{
var c=localStorage.getItem('${THEME_KEY}')||'${DEFAULT_THEME}';
var e=document.documentElement;
var s=location.pathname.indexOf('${SIGN_IN_PATH}')===0;
var d=s||c==='dark'||(c==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
e.setAttribute('data-theme',d?'dark':'light');
e.setAttribute('data-theme-choice',c);
}catch(_){}})();`;
