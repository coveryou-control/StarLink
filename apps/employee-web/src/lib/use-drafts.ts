'use client';

/**
 * Every conversation this person has unsent words in.
 *
 * The sidebar shows "Draft: …" where the last message would be, which is the one place a
 * person is told they left something unfinished. Nothing else in the shell reads drafts —
 * the composer loads its own by conversation — so this exists purely for that row.
 *
 * ## Why an event and not a poll
 *
 * IndexedDB notifies nobody. The composer's autosaver fires `DRAFT_CHANGED_EVENT` when it
 * writes and when it clears, and this re-reads on both, so the row appears about 400ms
 * after somebody stops typing and disappears the instant the message is sent. A poll would
 * either lag that or run for ever against a store that changes a few times an hour.
 */
import { useCallback, useEffect, useState } from 'react';

import { DRAFT_CHANGED_EVENT, DraftStore } from './drafts';

export function useDrafts(principalId: string | undefined): ReadonlyMap<string, string> {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());

  const reload = useCallback(() => {
    if (principalId === undefined) {
      setDrafts(new Map());
      return;
    }
    void DraftStore.listFor(principalId)
      .then(setDrafts)
      /* A private window with IndexedDB blocked is not an error state: no drafts is the
         honest answer, and the composer degrades the same way. */
      .catch(() => setDrafts(new Map()));
  }, [principalId]);

  useEffect(() => {
    reload();
    window.addEventListener(DRAFT_CHANGED_EVENT, reload);
    return () => window.removeEventListener(DRAFT_CHANGED_EVENT, reload);
  }, [reload]);

  return drafts;
}
