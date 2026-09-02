'use client';

/**
 * The team queue (SL-006, SL-037, SL-083 — §21.7, §23.4).
 *
 * SL-006's acceptance criterion is **"No invisible waiting; accurate counts"**, and until
 * now the employee surface showed an agent only their own conversations. Work waiting for
 * the team was invisible: `GET /v1/employee/queues/:teamId` had been built and guarded
 * since Phase 5 and nothing called it. A customer could wait in a queue nobody could see.
 *
 * ## Oldest first, and nothing else
 *
 * §23.4: "the customer who waited longest is served first", and priority bands are D-24
 * and unanswered — "without them, 'oldest first' is the whole rule". The API returns the
 * queue in that order and this renders it in the order received. It does **not** re-sort
 * by priority, because doing so would invent the band ordering the business has not given.
 *
 * ## No customer content
 *
 * A queue row carries the wait, the priority and the after-hours flag — never the message.
 * The API deliberately omits the body ("a queue view is a work list, and the body of a
 * waiting customer's message is not needed to decide whether to take it"), and rendering
 * it here would have required asking for it.
 */
import { useCallback, useEffect, useState } from 'react';
import { teamChannel } from '@starlink/shared-contracts/realtime';

import { api, ApiError, type QueueEntry } from '../lib/api-client';
import { useRoom } from '../lib/use-room';

const REFRESH_MS = 15_000;

/** Whole minutes; a queue measured in seconds reads as precision nobody acts on. */
function waitedFor(enqueuedAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(enqueuedAt)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`;
}

export function TeamQueue({
  teamId,
  onOpenConversation,
}: {
  readonly teamId: string;
  readonly onOpenConversation: (conversationId: string) => void;
}): React.JSX.Element {
  const [entries, setEntries] = useState<readonly QueueEntry[]>([]);
  const [claiming, setClaiming] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const view = await api.queue(teamId);
      setEntries(view.entries);
      setError(undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthenticated) return;
      // The queue is the one view where a silent failure is dangerous: an empty list and
      // an unreachable server look identical, and one of them means nobody is being served.
      setError('The queue could not be loaded. This is not the same as an empty queue.');
    }
  }, [teamId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /**
   * §20.7's Queue arrival, live (N-27). The poll above STAYS: §20.7 gives this row
   * "transport required: No" with "queue read on load" as the fallback, and a queue that
   * only updated on a socket would be a queue that silently stopped updating whenever the
   * socket dropped. The event makes it immediate; the poll makes it true.
   */
  useRoom(teamChannel(teamId), () => void refresh());

  const claim = async (entry: QueueEntry): Promise<void> => {
    setClaiming(entry.conversationId);
    setMessage(undefined);
    try {
      /**
       * The idempotency key makes a retried claim safe — a dropped response must not read
       * as a second claimant (golden G-06/G-07). Derived from the entry rather than
       * random, so the retry of THIS click carries the same key.
       */
      const outcome = await api.claim(entry.conversationId, `claim:${entry.queueEntryId}`);
      if (outcome.outcome === 'CLAIMED') {
        onOpenConversation(entry.conversationId);
      } else {
        // A losing claim is a 200, not an error: someone else took it, which is a normal
        // outcome and not worth an alarm.
        setMessage('Someone else took that one.');
      }
    } catch (cause) {
      setMessage(
        cause instanceof ApiError && cause.isRefusal
          ? 'That is no longer available.'
          : 'The claim did not go through. Nothing was taken.',
      );
    } finally {
      setClaiming(undefined);
      void refresh();
    }
  };

  return (
    <section className="queue" aria-label={`Queue for ${teamId}`}>
      <header className="queue-head">
        <h2 className="section-title">Waiting for {teamId}</h2>
        {/* The count is the point of SL-006. Zero is stated, never left blank. */}
        <span className="queue-count">{entries.length} waiting</span>
      </header>

      {error !== undefined ? <p role="alert">{error}</p> : null}
      {message !== undefined ? <p role="status">{message}</p> : null}

      {entries.length === 0 && error === undefined ? (
        <p className="muted">Nobody is waiting.</p>
      ) : null}

      <ul className="queue-list">
        {entries.map((entry) => (
          <li key={entry.queueEntryId}>
            <div className="queue-row">
              <span className="queue-wait">{waitedFor(entry.enqueuedAt)}</span>
              <span className="queue-priority">{entry.priority.toLowerCase()}</span>
              {/* §23.2: an after-hours arrival was acknowledged with no response-time
                  promise. Worth showing, so nobody reads its age as a broken promise. */}
              {entry.afterHours ? <span className="queue-after-hours">arrived after hours</span> : null}
              <button
                type="button"
                onClick={() => void claim(entry)}
                disabled={claiming !== undefined}
              >
                {claiming === entry.conversationId ? 'Taking…' : 'Take'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
