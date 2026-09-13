'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { api, type MessageInfo, type MessageView } from '../lib/api-client';

/**
 * Who has read one message, and when it was delivered — in the column beside the thread.
 *
 * ## Why this is not a dialog any more
 *
 * It was one: a centred box over a dimmed page, with a Close button at the bottom. Two
 * things were wrong with that, and the second is the one that matters.
 *
 * It covered the thread. "Who has read this" is a question ABOUT a message, and the answer
 * is only useful while the message is still on screen — a modal that hides the thing being
 * asked about makes the reader remember which message they clicked.
 *
 * And this product already decided this question. `[id]/page.tsx` says it, about the group
 * panel: *"Group info as a PLACE, not a popover"* — it used to hang off the chat header,
 * absolutely positioned inside a 68px row, and was moved into a column for exactly these
 * reasons. Message info was the last thing still doing it the old way, and a product with
 * one panel in a drawer and another in a modal is a product that has not decided.
 *
 * So it takes the same slot search and details take, and the thread narrows to make room
 * rather than being covered. At tablet width the drawer overlays; on a phone it is a
 * full-screen sheet. All three are the stylesheet's business — see `.details-drawer`.
 *
 * ## Why the sender is not in the list
 *
 * "You have read your own message" is not information. Including it would also make a
 * one-to-one report "1 of 2 read" while the other person had not opened it — a number
 * that looks like progress and is not. The server excludes them; this renders what it gets.
 *
 * ## Read means read PAST it
 *
 * Read markers advance in jumps: somebody who opens a thread after twenty more messages
 * have arrived has read this one too. The panel says "Read" rather than "Read this exact
 * message", and the time shown is when their marker last moved, which is the closest true
 * answer the read model can give. It is only shown for people who have actually passed this
 * message — printing a marker time beside "Not read yet" would read as a contradiction.
 *
 * ## Loaded when opened
 *
 * It is a join against every participant. Folding it into the message projection would pay
 * for fifty of them on every page to answer a question asked about one.
 */
export function MessageInfoPanel({
  message,
  conversationId,
  onClose,
  /** True while the drawer is an overlay rather than a column — see the thread page. */
  overlaid = false,
}: {
  readonly message: MessageView;
  readonly conversationId: string;
  readonly onClose: () => void;
  readonly overlaid?: boolean;
}): ReactNode {
  const [info, setInfo] = useState<MessageInfo | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  useEffect(() => {
    /* Escape still closes it. It is no longer modal, but it is still a thing that opened
       in response to a click and the key people reach for has not changed. */
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setInfo(undefined);
    setProblem(undefined);
    void api
      .messageInfo(conversationId, message.messageId)
      .then((result) => {
        if (live) setInfo(result);
      })
      .catch(() => {
        if (live) setProblem('That could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [conversationId, message.messageId]);

  const time = (at: string): string =>
    new Date(at).toLocaleString([], {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  const read = info?.readers.filter((reader) => reader.hasRead) ?? [];
  const unread = info?.readers.filter((reader) => !reader.hasRead) ?? [];

  return (
    <aside className="details-drawer" aria-label="Message info">
      <header className="details-head">
        {/*
          A back chevron when the drawer is a page, a cross when it is a column — the same
          rule the details panel follows, and for the same reason: at overlay width this is
          a screen you came from somewhere, and a page is left with a back control.
        */}
        <button
          type="button"
          className={overlaid ? 'details-close' : 'details-dismiss'}
          onClick={onClose}
          aria-label="Close message info"
        >
          {overlaid ? (
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <path
                d="M15 4.5 7.5 12l7.5 7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
        <h2>Message info</h2>
      </header>

      <div className="details-body">
        {/*
          The message itself, at the top, so the panel says what it is about.

          A bubble rather than a quotation rule: it is a message, and drawing it as one means
          nobody has to work out which of the forty on the left this panel belongs to.
        */}
        <div className="message-info-subject">
          {message.body.trim() === '' ? (
            <span className="muted">This message has no text.</span>
          ) : (
            message.body
          )}
        </div>

        {problem !== undefined ? (
          <p role="alert" className="state-note">
            {problem}
          </p>
        ) : info === undefined ? (
          /* Shapes rather than the word, matching every other waiting state in the product. */
          <div className="message-info-loading" aria-hidden="true">
            <span className="skeleton-line" style={{ width: '58%' }} />
            <span className="skeleton-line short" style={{ width: '38%' }} />
          </div>
        ) : (
          <>
            <section className="details-section">
              <h3 className="details-section-title">Delivered</h3>
              <p className="message-info-when">{time(info.deliveredAt)}</p>
            </section>

            {info.readers.length === 0 ? (
              /* A conversation with nobody else in it. Saying "0 of 0 have read this" is
                 arithmetic; saying there is nobody is the fact. */
              <p className="details-note">Nobody else is in this conversation.</p>
            ) : (
              <>
                {/*
                  Read and not-read as two SECTIONS, not one list with a status column.

                  The old panel put "Not read yet" in the right-hand column of a row, which
                  is where a timestamp goes — so the two answers occupied the same slot and
                  the eye had to read every line to count. Two headed groups answer "has
                  everybody seen it" without reading anything.
                */}
                <section className="details-section">
                  <h3 className="details-section-title">
                    Read <span className="details-count">{read.length}</span>
                  </h3>
                  {read.length === 0 ? (
                    <p className="details-note">Nobody has read this yet.</p>
                  ) : (
                    <ul className="message-info-readers">
                      {read.map((reader) => (
                        <li key={reader.principalId}>
                          <span>{reader.displayName}</span>
                          <span className="muted">
                            {reader.readAt !== undefined ? time(reader.readAt) : 'Read'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {unread.length > 0 ? (
                  <section className="details-section">
                    <h3 className="details-section-title">
                      Not read yet <span className="details-count">{unread.length}</span>
                    </h3>
                    <ul className="message-info-readers">
                      {unread.map((reader) => (
                        <li key={reader.principalId}>
                          <span>{reader.displayName}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
