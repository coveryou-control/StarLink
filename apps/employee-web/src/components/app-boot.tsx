/**
 * The application before it knows who you are.
 *
 * ## What this replaces
 *
 * `<p style={{ padding: 24 }}>Loading…</p>` — literally that, in two places. A bare
 * paragraph in the top-left corner of a white page, with an inline style because there was
 * no rule for it, shown for as long as the session takes to resolve. It is the first thing
 * anybody sees on a cold load, and it says the product has not been built yet.
 *
 * ## Why a silhouette rather than a spinner
 *
 * The three panes are always in the same places, so drawing them costs nothing and buys
 * everything: the frame appears at once, the content fills in, and nothing MOVES when it
 * does. A spinner centred on a blank page gives the layout no chance to settle, so the real
 * interface arrives as a jump.
 *
 * It reuses `.app-shell` and `.app-body` for exactly that reason — this is not a picture of
 * the application, it is the application with nothing in it yet.
 *
 * ## It says nothing
 *
 * No "Loading…", no "Please wait". The shapes already say it, and a screen reader gets the
 * one sentence that matters from the live region rather than from eight empty boxes —
 * `aria-hidden` on the silhouette is what keeps those out of the accessibility tree.
 */
import type { ReactNode } from 'react';

export function AppBoot(): ReactNode {
  return (
    <div className="app-shell app-boot" aria-busy="true">
      {/* The rail: four destinations and the avatar, at the sizes they will be. */}
      <div className="boot-rail" aria-hidden="true">
        <span className="boot-mark" />
        <span className="boot-tile" />
        <span className="boot-tile" />
        <span className="boot-tile" />
        <span className="boot-tile" />
        <span className="boot-rail-foot" />
      </div>

      <div className="app-body">
        <aside className="boot-list" aria-hidden="true">
          <span className="boot-title" />
          <span className="boot-field" />
          {/*
            Widths that vary, because a list of eight identical bars reads as a loading
            GRAPHIC rather than as a list arriving. The same reasoning the conversation
            list's own skeleton uses.
          */}
          {[74, 58, 66, 80, 52, 70, 62].map((width, index) => (
            <span key={width} className="boot-row">
              <span className="boot-avatar" />
              <span className="boot-lines">
                <span className="boot-line" style={{ width: `${width}%` }} />
                <span className="boot-line short" style={{ width: `${width - 18}%` }} />
              </span>
              {index === 0 ? null : null}
            </span>
          ))}
        </aside>

        <main className="boot-thread" aria-hidden="true">
          <span className="boot-header" />
          <span className="boot-body" />
          <span className="boot-composer" />
        </main>
      </div>

      {/* The one thing a screen reader is told. `role="status"` rather than `alert`: it is
          a state, not a problem. */}
      <p className="sr-only" role="status">
        Loading StarLink…
      </p>
    </div>
  );
}
