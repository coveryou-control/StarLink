'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { avatarFor, conversationLabel } from './conversation-naming';
import { GroupGlyph } from './group-glyph';
import type { ConversationSummary, MessageView } from '../lib/api-client';

/**
 * Where to send a message on to.
 *
 * ## Chosen from conversations you are already in
 *
 * Not from the directory. Forwarding into a conversation is a write, and the server
 * refuses one you are not a participant of — offering the whole company here would mean
 * most of the list produced a refusal. Starting a new conversation to forward into is two
 * deliberate actions, and it should stay that way: "New chat" then paste.
 *
 * ## One destination at a time
 *
 * Multi-select forces a partial-success answer — "two of your four went, and no, we will
 * not say which two" — that a person cannot act on. Four separate sends can each be
 * reported on, and in practice nobody forwards to four places.
 *
 * ## The preview is the whole point
 *
 * Forwarding is the action people most often perform on the wrong message: the menu was
 * opened from a row, and by the time the dialog is up the row is behind it. Showing the
 * text being forwarded turns "I think that was the right one" into a check.
 */
export function ForwardDialog({
  message,
  conversations,
  excludeConversationId,
  onForward,
  onCancel,
}: {
  readonly message: MessageView;
  readonly conversations: readonly ConversationSummary[];
  /** The conversation it is already in — forwarding there is a no-op. */
  readonly excludeConversationId: string;
  readonly onForward: (toConversationId: string) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [term, setTerm] = useState('');
  const [sending, setSending] = useState<string | undefined>();
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fieldRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  /* Filtered locally: these are the conversations the shell already holds, and a round
     trip to narrow a list of twenty would be slower than the typing. */
  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return conversations
      .filter((c) => c.conversationId !== excludeConversationId)
      .filter((c) => needle === '' || conversationLabel(c).toLowerCase().includes(needle));
  }, [conversations, excludeConversationId, term]);

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <section
        className="forward-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Forward message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Forward to</h2>

        <blockquote className="forward-preview">{message.body}</blockquote>

        <input
          ref={fieldRef}
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search your conversations"
          aria-label="Search your conversations"
        />

        {matches.length === 0 ? (
          <p className="muted">No conversation matches that.</p>
        ) : (
          <ul className="forward-list">
            {matches.map((conversation) => {
              const mark = avatarFor(conversation);
              return (
                <li key={conversation.conversationId}>
                  <button
                    type="button"
                    /* Disabled only while ITS OWN send is in flight, so a slow network
                       cannot produce two copies from one impatient double-click, and the
                       rest of the list stays usable. */
                    disabled={sending !== undefined}
                    onClick={() => {
                      setSending(conversation.conversationId);
                      onForward(conversation.conversationId);
                    }}
                  >
                    <span className={`row-avatar${mark.isGroup ? ' group' : ''}`} aria-hidden="true">
                      {mark.isGroup ? <GroupGlyph /> : mark.text}
                    </span>
                    <span>{conversationLabel(conversation)}</span>
                    {sending === conversation.conversationId ? (
                      <span className="muted">Sending…</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button type="button" className="confirm-cancel" onClick={onCancel}>
          Cancel
        </button>
      </section>
    </div>,
    document.body,
  );
}
