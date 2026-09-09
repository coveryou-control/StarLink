import type { ReactNode } from 'react';

/**
 * The thread, while the route is arriving.
 *
 * ## What was on screen instead
 *
 * The empty pane — "No conversation selected", with its two buttons — for the whole of the
 * navigation. Clicking a conversation told you, for as long as it took, that you had not
 * clicked one. Worse than a blank: it is a confident statement of the opposite of what just
 * happened, and on a slow connection people click again.
 *
 * Next renders this as the segment's Suspense fallback the instant the navigation starts,
 * so the pane the reader is looking at becomes a thread immediately and then fills in.
 *
 * ## Why the shapes and not a spinner
 *
 * The header and the composer are drawn at their real heights, so the messages land in the
 * space already reserved for them and nothing jumps. That is the whole value here: the
 * distance between this and the loaded thread is text appearing, not a layout being decided.
 *
 * ## Why the bubbles alternate
 *
 * A conversation is two people. A column of identical left-aligned bars reads as a list
 * loading; alternating sides at varying widths reads as messages coming, which is what is
 * actually happening. The same reasoning — and the same classes — as the in-page skeleton
 * the thread already shows while it pages.
 */
export default function LoadingThread(): ReactNode {
  return (
    <div className="thread-stage details-hidden">
      <div className="thread-pane">
        {/* Real height, so the messages below it do not shift when the header resolves. */}
        <div className="thread-loading-header" aria-hidden="true">
          <span className="thread-loading-avatar" />
          <span className="thread-loading-lines">
            <span className="skeleton-line" style={{ width: 140 }} />
            <span className="skeleton-line short" style={{ width: 84 }} />
          </span>
        </div>

        <div className="thread-scroll">
          <div className="thread-skeleton" aria-hidden="true">
            {[68, 44, 80, 52, 36].map((width, index) => (
              <div
                key={width}
                className={`skeleton-bubble${index % 2 === 1 ? ' mine' : ''}`}
                style={{ width: `${width}%` }}
              />
            ))}
          </div>
        </div>

        <div className="thread-loading-composer" aria-hidden="true" />
      </div>

      {/* The word, for a screen reader, which gets nothing useful from five empty boxes. */}
      <p className="sr-only" role="status">
        Opening this conversation…
      </p>
    </div>
  );
}
