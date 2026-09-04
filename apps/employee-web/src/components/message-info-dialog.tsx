'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, type MessageInfo, type MessageView } from '../lib/api-client';

/**
 * Who has read one message, and when it was delivered.
 *
 * ## Why the sender is not in the list
 *
 * "You have read your own message" is not information. Including it would also make a
 * one-to-one report "1 of 2 read" while the other person had not opened it — a number
 * that looks like progress and is not. The server excludes them; this renders what it
 * gets.
 *
 * ## Read means read PAST it
 *
 * Read markers advance in jumps: somebody who opens a thread after twenty more messages
 * have arrived has read this one too. The panel says "Read" rather than "Read this exact
 * message", and the time shown is when their marker last moved, which is the closest true
 * answer the read model can give. It is only shown for people who have actually passed
 * this message — printing a marker time beside "Not read yet" would read as a
 * contradiction.
 *
 * ## Loaded when opened
 *
 * It is a join against every participant. Folding it into the message projection would
 * pay for fifty of them on every page to answer a question asked about one.
 */
export function MessageInfoDialog({
  message,
  conversationId,
  onClose,
}: {
  readonly message: MessageView;
  readonly conversationId: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [info, setInfo] = useState<MessageInfo | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
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

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="message-info-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Message info"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Message info</h2>

        <blockquote className="forward-preview">{message.body}</blockquote>

        {problem !== undefined ? (
          <p role="alert" className="muted">
            {problem}
          </p>
        ) : info === undefined ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p className="message-info-delivered">
              <strong>Delivered</strong> {time(info.deliveredAt)}
            </p>

            {info.readers.length === 0 ? (
              /* A conversation with nobody else in it. Saying "0 of 0 have read this" is
                 arithmetic; saying there is nobody is the fact. */
              <p className="muted">Nobody else is in this conversation.</p>
            ) : (
              <>
                <p className="message-info-count">
                  Read by {info.readers.filter((reader) => reader.hasRead).length} of{' '}
                  {info.readers.length}
                </p>
                <ul className="message-info-readers">
                  {info.readers.map((reader) => (
                    <li key={reader.principalId}>
                      <span>{reader.displayName}</span>
                      <span className="muted">
                        {reader.hasRead
                          ? reader.readAt !== undefined
                            ? time(reader.readAt)
                            : 'Read'
                          : 'Not read yet'}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        <button type="button" className="confirm-cancel" onClick={onClose}>
          Close
        </button>
      </section>
    </div>,
    document.body,
  );
}
