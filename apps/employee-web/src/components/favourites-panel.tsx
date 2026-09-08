'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError } from '../lib/api-client';
import { initialsFor, senderColour } from './conversation-naming';
/* The thread's own formatter, imported rather than reimplemented — two copies is how two
   parts of one product start printing times differently. */
import { formatTimestamp } from './message-list';

interface Starred {
  readonly messageId: string;
  readonly conversationId: string;
  readonly body: string;
  readonly senderPrincipalId: string;
  readonly senderDisplayName: string;
  readonly sentAt: string;
  readonly starredAt: string;
}

/**
 * Favourites — every message this reader has starred, across every conversation.
 *
 * ## Why it is a list of MESSAGES and not of conversations
 *
 * Asked for on 2026-09-08 and worth stating, because the sidebar's other entries are all
 * lists of threads: a star marks a sentence somebody needs again — a decision, an address,
 * a number — and the thread it was in is a detail of where to find it, not the thing being
 * kept. Listing threads would answer a question nobody asked.
 *
 * ## Why it re-reads on open rather than living in the shell
 *
 * Stars are made in the thread and read here, so the two views are never on screen at once
 * and there is nothing to keep in step. A fetch on open is simpler than a cache that has to
 * be invalidated by an action in another component, and this list is small by nature.
 */
export function FavouritesPanel({
  onOpen,
}: {
  /** Jump to the conversation a starred message came from. */
  readonly onOpen: (conversationId: string, messageId: string) => void;
}): ReactNode {
  const [items, setItems] = useState<readonly Starred[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const page = await api.starred();
        if (live) setItems(page.starred);
      } catch (cause) {
        if (live && !(cause instanceof ApiError && cause.isUnauthenticated)) setFailed(true);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="thread-empty">
        <p className="state-note">Loading…</p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="thread-empty">
        <p className="state-note">
          <strong>Could not load your favourites</strong>
          The list is still there — this is a problem reading it, not a problem with it.
        </p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="thread-empty">
        <p className="state-note">
          <strong>Nothing starred yet</strong>
          Star a message from its menu and it will wait for you here, whichever conversation
          it came from.
        </p>
      </div>
    );
  }

  return (
    <ul className="favourites" aria-label="Starred messages">
      {items.map((item) => (
        <li key={item.messageId}>
          {/*
            The whole row opens the thread AT the message.

            A star is a bookmark, and a bookmark that only shows you the text has done half
            its job — the reason to keep a sentence is almost always the conversation
            around it.
          */}
          <button
            type="button"
            className="favourite-row"
            onClick={() => onOpen(item.conversationId, item.messageId)}
          >
            <span
              className="favourite-avatar"
              aria-hidden="true"
              style={{ color: senderColour(item.senderPrincipalId) }}
            >
              {initialsFor(item.senderDisplayName)}
            </span>
            <span className="favourite-main">
              <span className="favourite-head">
                <strong style={{ color: senderColour(item.senderPrincipalId) }}>
                  {item.senderDisplayName}
                </strong>
                <time dateTime={item.sentAt}>{formatTimestamp(item.sentAt)}</time>
              </span>
              {/* Clamped to three lines by the stylesheet: this is an index, and a starred
                  essay must not push the next bookmark off the screen. */}
              <span className="favourite-body">{item.body}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
