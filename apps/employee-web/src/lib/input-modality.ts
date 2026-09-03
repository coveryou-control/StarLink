/**
 * Whether the person is currently driving with a pointer or a keyboard.
 *
 * ## Why this exists
 *
 * A focus ring on a text field is not decoration — NFR-ACC-1 requires the product to be
 * fully operable from a keyboard, and that is impossible if you cannot see where the caret
 * has gone. So it cannot simply be removed.
 *
 * But `:focus-visible` does not mean what its name suggests for text fields. The Selectors
 * spec has the browser match it on ANY focus of a text input, mouse clicks included — the
 * heuristic that keeps a ring off a clicked button deliberately does not apply, on the
 * reasoning that somebody who has clicked into a field is about to type and wants to know
 * where. The consequence is a ring flashing onto the search box and the composer every
 * time somebody reaches for them with a mouse, which is exactly the thing nobody asked to
 * see.
 *
 * So the modality is tracked directly. `data-pointer` on the root element means "the last
 * thing this person did was point at something", and the stylesheet suppresses the ring
 * while it is there. Press Tab and it goes, and the ring comes back for the whole session
 * until the mouse is used again.
 *
 * ## It fails in the safe direction
 *
 * The attribute is ADDED by this script and its absence is the accessible state. If the
 * script never runs — no JavaScript, an error before this line, a browser that does not
 * support `pointerdown` — there is no attribute, the plain rules apply, and every field
 * shows its ring. The degradation is "slightly noisier than intended", never "no visible
 * focus".
 *
 * ## Why an inline boot script
 *
 * Same reason as the theme: it has to run before the first paint. Registered from a React
 * effect it would attach after hydration, and the first click of a session — which is
 * usually the sign-in field — would still flash.
 */

/** Keys that mean somebody is navigating rather than typing into a field they clicked. */
const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
]);

/**
 * Inlined into the document head. Written as a string for the same reason `themeBootScript`
 * is: it must be in the HTML, not in a bundle that arrives later.
 *
 * Deliberately not `keydown` on everything. Typing into a field you clicked into is not
 * keyboard NAVIGATION, and treating it as such would put the ring back the moment somebody
 * started writing — which is the case this exists to prevent.
 */
export const inputModalityBootScript = `
(function () {
  try {
    var root = document.documentElement;
    var nav = ${JSON.stringify([...NAVIGATION_KEYS])};
    var pointer = function () { root.setAttribute('data-pointer', ''); };
    var keyboard = function (event) {
      if (event.metaKey || event.altKey || event.ctrlKey) return;
      if (nav.indexOf(event.key) === -1) return;
      root.removeAttribute('data-pointer');
    };
    // Capture, so a handler that stops propagation cannot leave the modality stale.
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
  } catch (error) {
    // No attribute means every field shows its ring, which is the safe outcome.
  }
})();
`;
