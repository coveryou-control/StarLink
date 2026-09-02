'use client';

/**
 * A thread, in the fourth column — design screen 03.
 *
 * ## Why it is a column and not a modal
 *
 * A thread is a conversation about one message, and you read it while the channel is still
 * on screen: that is the entire reason to thread rather than reply. A modal would cover the
 * thing the thread is about. It takes the information panel's column because at any moment
 * you are either asking "who is this" or "what did people say about that" — never both — and
 * two 320px columns beside a conversation leaves the conversation nothing.
 *
 * ## It re-fetches rather than filtering what the channel already has
 *
 * The channel page deliberately does NOT contain threaded replies, so there is nothing here
 * to filter. Asking the server is also what makes this correct across a reload, a deep link
 * and a realtime event — invariant 9: recovery is re-fetch, and no state exists only in an
 * event.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type MessageView } from '../lib/api-client';
import { Composer } from './composer';
import { MessageList } from './message-list';
import type { PendingSend } from './composer';

export function ThreadPane({
  conversationId,
  root,
  principalId,
  senderDisplayName,
  isGroup,
  conversationIsInternal,
  onClose,
  onRepliesChanged,
}: {
  readonly conversationId: string;
  readonly root: MessageView;
  readonly principalId: string;
  readonly senderDisplayName: string;
  readonly isGroup: boolean;
  readonly conversationIsInternal: boolean;
  readonly onClose: () => void;
  /**
   * The channel's own page carries the reply count, so it has to be told when this one
   * changes it — otherwise "3 replies" stays 3 until the next full load.
   */
  readonly onRepliesChanged: () => void;
}): ReactNode {
  const [replies, setReplies] = useState<readonly MessageView[]>([]);
  const [pending, setPending] = useState<readonly PendingSend[]>([]);
  const [problem, setProblem] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await api.messages(conversationId, { thread: root.messageId, limit: 100 });
      /* The API pages newest first, like every other message read. A thread is read in the
         order it was written, so it is reversed once here rather than by every consumer. */
      setReplies([...page.messages].reverse());
      setProblem(undefined);
    } catch (cause) {
      /* An empty thread and an unreachable server must not look the same — the rule the
         inbox and the announcements board both obey. */
      setProblem(
        cause instanceof ApiError && cause.isUnauthenticated
          ? 'Your session has ended.'
          : 'The replies could not be loaded. This is not the same as none.',
      );
    } finally {
      setLoading(false);
    }
  }, [conversationId, root.messageId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  /* The confirmed message replaces the optimistic one, exactly as in the channel. */
  const confirmedClientIds = new Set(
    replies.map((message) => message.clientMessageId).filter((id): id is string => id !== undefined),
  );
  const stillPending = pending.filter((item) => !confirmedClientIds.has(item.localId));

  return (
    <aside className="thread-pane-column" aria-label={`Thread on ${root.senderDisplayName}'s message`}>
      <header className="details-head">
        <h2>Thread</h2>
        <button type="button" className="details-close" onClick={onClose} aria-label="Close thread">
          <span aria-hidden="true">&times;</span>
        </button>
      </header>

      <div className="thread-pane-scroll">
        {/*
          The root, at the top and marked as the root.

          Rendered through the same `MessageList` as everything else rather than as a
          bespoke block: a thread's first message is a message, and a second renderer for it
          is a second place for mentions, attachments and deletions to be got wrong.
        */}
        <div className="thread-root">
          <MessageList
            messages={[root]}
            pending={[]}
            currentPrincipalId={principalId}
            conversationIsInternal={conversationIsInternal}
            isGroup={isGroup}
            readWatermark={0}
          />
        </div>

        <p className="thread-count">
          {loading
            ? 'Loading replies…'
            : replies.length === 0
              ? 'No replies yet'
              : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
        </p>

        {problem !== undefined ? (
          <p className="panel-note" role="alert">
            {problem}
          </p>
        ) : (
          <MessageList
            messages={replies}
            pending={stillPending}
            currentPrincipalId={principalId}
            conversationIsInternal={conversationIsInternal}
            isGroup={isGroup}
            readWatermark={0}
          />
        )}
      </div>

      <Composer
        conversationId={conversationId}
        principalId={principalId}
        senderDisplayName={senderDisplayName}
        threadParentId={root.messageId}
        placeholder="Reply in thread…"
        /*
           A thread on an internal conversation has no customer to reply to, exactly as the
           channel's own composer decides — passed through rather than re-derived, so the two
           cannot disagree about the same thread.
        */
        canReplyToCustomer={!conversationIsInternal}
        onSent={(message) => {
          setReplies((current) => [...current, message]);
          onRepliesChanged();
        }}
        onPendingChange={setPending}
      />
    </aside>
  );
}
