'use client';

import { useEffect, useRef, useState } from 'react';
import { SEARCH_MINIMUM_TERM_LENGTH } from '@starlink/shared-contracts';
import type { ReactNode } from 'react';

import { initialsFor } from './conversation-naming';
import { PresenceDot, PresenceProvider } from './presence';
import { useSession } from './session-provider';
import { usePresence } from '../lib/use-presence';
import { api, ApiError, type DirectoryEntry } from '../lib/api-client';

/**
 * Colleague directory (FR-DIR-*).
 *
 * Search runs server-side and scoped (doc §30.2, scope-before-query) — this component
 * never receives a full principal list to filter locally, because a client-side filter
 * over a global list means the whole list was already on the wire.
 *
 * ## It starts the conversation now
 *
 * It used to render names and stop. Finding a colleague and then having to close the
 * directory, open "New conversation" and search for the same person again is the product
 * asking you to do the same thing twice — and it made the directory look decorative, which
 * is how a feature gets read as unfinished. A row is now the action: click it and you are
 * in the thread.
 *
 * `createConversation` is idempotent for a 1:1 (BR-05), so this opens an existing thread
 * as readily as it starts a new one and the caller cannot tell which happened. That is the
 * right behaviour — "message Priya" means the same thing either way.
 */
export function Directory({
  onOpenConversation,
}: {
  readonly onOpenConversation: (conversationId: string) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly DirectoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The colleague whose conversation is being opened, so only that row shows a spinner. */
  const [opening, setOpening] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const { state } = useSession();
  /**
   * You are in the directory, and you must not be offered as somebody to message.
   *
   * The endpoint returns every matching principal including the caller, so searching your
   * own name listed you with a "Message" action that the server then refuses — BR-05's
   * 1:1 is between two people. Filtered here rather than server-side because the
   * directory is also used for lookups where seeing yourself is correct.
   */
  const me = state.status === 'SIGNED_IN' ? state.me.principalId : undefined;

  /**
   * The team, loaded once, so People opens with names in it.
   *
   * It was an empty box: nothing appeared until you typed two characters, so the answer to
   * "who can I message" was "somebody you can already name". This is not a search with a
   * blank term — FR-SRCH-5 refuses those on purpose — it is the membership of the teams
   * the session already says you are in.
   */
  const [colleagues, setColleagues] = useState<readonly DirectoryEntry[]>([]);
  const [loadingTeam, setLoadingTeam] = useState(true);

  const searched = query.trim().length >= 2;
  /**
   * Presence for the people this search found.
   *
   * Asked here rather than by the shell because a colleague you have never spoken to has
   * no conversation row, so the shell's set cannot contain them. Scoped to the visible
   * results, which is at most a page.
   */
  const onlineHere = usePresence(
    (searched ? results : colleagues).map((entry) => entry.principalId),
  );

  useEffect(() => {
    let cancelled = false;
    void api
      .colleagues()
      .then((page) => {
        if (cancelled) return;
        setColleagues(page.entries.filter((entry) => entry.principalId !== me));
      })
      .catch(() => {
        // Silent: the search below still works, and an error banner over a pane whose
        // primary control is fine would be reporting the wrong thing.
        if (!cancelled) setColleagues([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingTeam(false);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);


  useEffect(() => {
    const trimmed = query.trim();
    /* The server's floor, not a second opinion about it — see `SEARCH_MINIMUM_TERM_LENGTH`.
       This was a literal 2 while the directory endpoint also refused below 2, so the two
       agreed by luck; the endpoint accepts one character now and this would have kept
       swallowing it. */
    if (trimmed.length < SEARCH_MINIMUM_TERM_LENGTH) {
      setResults([]);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setBusy(true);
    // Debounced so typing does not issue a request per keystroke.
    const timer = setTimeout(() => {
      void api
        .directory(trimmed)
        .then((page) => {
          if (cancelled) return;
          setResults(page.entries.filter((entry) => entry.principalId !== me));
          setFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          /**
           * "We could not look" is not "nobody matched". Conflating them tells somebody a
           * colleague does not exist when the truth is that the directory is unreachable
           * — and they act on it by giving up rather than by retrying.
           */
          setFailed(true);
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, me]);

  const openWith = async (entry: DirectoryEntry): Promise<void> => {
    setOpening(entry.principalId);
    setError(undefined);
    try {
      const result = await api.createConversation({
        type: 'INTERNAL_DIRECT',
        participantIds: [entry.principalId],
      });
      setQuery('');
      setResults([]);
      onOpenConversation(result.conversationId);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.isRefusal
          ? `You cannot start a conversation with ${entry.displayName}.`
          : 'That did not go through. Try again.',
      );
    } finally {
      setOpening(undefined);
    }
  };

  return (
    <section aria-label="Directory" className="directory">
      <div className="field-with-clear">
          {/*
            The magnifier is inside the field, not beside it. A search box needs to be
            recognisable before it is read.
          */}
          <span className="field-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" focusable="false">
              <circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="m15.6 15.6 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
        <label>
          {/*
            The heading is the accessible name and nothing else. A visible uppercase
            caption above the field cost a whole row in a column that has to fit a
            conversation list on a phone, and said what the placeholder already said.
          */}
          <span className="sr-only">Directory</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Escape clears without leaving the field — the standard way out of a
              // search box, and the one people try first.
              if (event.key === 'Escape' && query !== '') {
                event.preventDefault();
                setQuery('');
              }
            }}
            placeholder="Find a colleague…"
          />
        </label>
        {query !== '' ? (
          <button
            type="button"
            className="field-clear"
            aria-label="Clear the directory search"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </div>

      <div aria-live="polite">
        {busy ? <p className="muted result-note">Searching…</p> : null}
        {!busy && failed ? (
          <p role="alert" className="result-note result-note-error">
            The directory is unavailable — this is not the same as no matches.
          </p>
        ) : null}
        {!busy && !failed && searched && results.length === 0 ? (
          <p className="muted result-note">No colleague matches “{query.trim()}”.</p>
        ) : null}

        {/*
          The resting state of this panel, which is most of the time it is on screen.

          Without it the panel is a search box above several hundred pixels of nothing —
          which reads as a screen that failed to load rather than as one waiting for input,
          and gives no clue what typing here will do.
        */}
        {/*
          Nothing typed: show the team, or say why there is nobody to show. The empty state
          is now only for the case where there genuinely is nobody — which on this stage
          means the HRMS placeholder has no team memberships seeded, and saying so beats a
          prompt to search a directory that would return nothing either.
        */}
        {!searched && !loadingTeam && colleagues.length === 0 ? (
          <p className="state-note">
            <strong>Find a colleague</strong>
            Search by name or department. Pick someone to open a conversation with them.
          </p>
        ) : null}
        {!searched && colleagues.length > 0 ? (
          <p className="section-title">Your team</p>
        ) : null}
        {error !== undefined ? (
          <p role="alert" className="result-note result-note-error">
            {error}
          </p>
        ) : null}

        <PresenceProvider online={onlineHere}>
        <ul className="people-list">
          {/*
            One list, two sources: the search's results while there is a term, the team
            otherwise. A second list would mean a second copy of the row — and the row is
            where presence, the interim-authority marker and the open-a-conversation
            action all live.
          */}
          {(searched ? results : colleagues).map((entry) => (
            <li key={entry.principalId}>
              <button
                type="button"
                className="person-row"
                onClick={() => void openWith(entry)}
                disabled={opening !== undefined}
              >
                <span className="avatar-wrap">
                  <span className="row-avatar" aria-hidden="true">
                    {initialsFor(entry.displayName)}
                  </span>
                  <PresenceDot principalId={entry.principalId} />
                </span>
                <span className="person-text">
                  <span className="person-name">{entry.displayName}</span>
                  <span className="person-meta">
                    {entry.department}
                    {/*
                      INTEGRATION_CONTRACTS §1 rule 4: an interim identity source must
                      never be mistakable for a canonical one.
                    */}
                    {entry.authority !== 'CANONICAL' ? (
                      <span className="provisional" title="Directory data is interim (HRMS pending)">
                        {' · interim'}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="person-action" aria-hidden="true">
                  {opening === entry.principalId ? 'Opening…' : 'Message'}
                </span>
              </button>
            </li>
          ))}
        </ul>
        </PresenceProvider>
      </div>
    </section>
  );
}
