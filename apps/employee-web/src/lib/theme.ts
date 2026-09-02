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
 */

const THEME_KEY = 'starlink.theme';

export type Theme = 'system' | 'light' | 'dark';

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
var c=localStorage.getItem('${THEME_KEY}')||'system';
var d=c==='dark'||(c==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
var e=document.documentElement;
e.setAttribute('data-theme',d?'dark':'light');
e.setAttribute('data-theme-choice',c);
}catch(_){}})();`;
