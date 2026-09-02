'use client';

/**
 * A width question the markup can ask, not just the stylesheet.
 *
 * Most responsive work belongs in CSS and stays there. This exists for the cases where the
 * two layouts are not the same tree wearing different clothes — where a control genuinely
 * should not be in the document at one width.
 *
 * The information panel is the first of them. In the design it is a permanent fourth
 * column with no header of its own; when the viewport cannot hold four columns it becomes
 * an overlay, and an overlay needs a way out. Rendering that close button always and
 * hiding it with `display: none` on desktop would leave a focusable, screen-reader-visible
 * control for an affordance that does not exist there — the exact class of "fix" that
 * makes a keyboard tab order disagree with the picture.
 *
 * ## It starts false, deliberately
 *
 * There is no viewport during server rendering, and guessing one produces a first paint
 * that contradicts the second. Starting from the desktop composition and correcting on
 * mount means the wide case never flickers and the narrow case corrects once, before
 * anything is interactive. Callers must therefore treat `false` as "not yet known to
 * match", which for a progressive enhancement like a close button is the safe reading.
 */
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const list = window.matchMedia(query);
    const update = (): void => setMatches(list.matches);
    update();

    /*
       `addEventListener` on a MediaQueryList is the current API; Safari carried the older
       `addListener` well past the point where this codebase's other browser assumptions
       were made, so both are wired and both are torn down.
    */
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', update);
      return () => list.removeEventListener('change', update);
    }
    list.addListener(update);
    return () => list.removeListener(update);
  }, [query]);

  return matches;
}
