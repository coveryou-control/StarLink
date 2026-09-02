'use client';

/**
 * Scoped conversation search (SL-081, §30).
 *
 * The endpoint, the rate limiter and the client method all existed; no screen called any
 * of them. Found on 2026-08-29 by the orphan guard in `ui-consumers.test.ts`, not by
 * reading — which is the point of having the guard.
 *
 * ## The scope is not this component's business
 *
 * §30's contract puts the authorized scope in the SIGNATURE server-side — "an unscoped
 * search is uncompilable" — so this sends a term and nothing else. There is deliberately
 * no team filter, no "search all conversations" toggle and no way to widen: a control that
 * offered a wider scope would be offering something the server will refuse, and the honest
 * place for that rule is the one that already enforces it.
 *
 * ## A snippet, never the message
 *
 * §30 returns what matched and where. Opening the conversation is how the message is read,
 * behind the same authorization every other read goes through. Rendering a full body here
 * would be a second read path with its own visibility rules to get wrong — and internal
 * notes are in the index for staff, so that path would be exactly where a leak lands.
 *
 * ## Why it types rather than submits
 *
 * It was a form: type, then press Search, then read a count. That is a query interface,
 * and nobody uses one to find a message they half-remember. It now searches as you type,
 * debounced, with Escape to clear — the interaction every messaging application has, and
 * the one people try before they look for a button.
 *
 * The debounce is 300ms and the minimum is two characters, both for the same reason: §30
 * rate-limits this endpoint, and a request per keystroke would spend that budget in a
 * second and then show a rate-limit message to somebody who searched once.
 */
import { useEffect, useRef, useState } from 'react';

import {
  api,
  ApiError,
  type ConversationSummary,
  type DirectoryEntry,
  type SearchHit,
  type SharedFile,
} from '../lib/api-client';
import { conversationLabel, initialsFor, relativeTime as when } from './conversation-naming';
import { extensionOf, formatBytes } from './attachment-picker';
import { requestBrowseDirectory } from '../lib/shell-actions';

/**
 * The reference's four tabs. "All" is not a fourth query — it is the other three, shown
 * together, which is what "one result set" means on screen 04.
 */
type Facet = 'all' | 'messages' | 'files' | 'people';

const DEBOUNCE_MS = 300;
const MIN_LENGTH = 2;

/**
 * `ts_headline` marks the matched words with `<<` and `>>` (see `search-provider.ts`,
 * which sets `StartSel`/`StopSel`), and the sidebar was printing those four characters
 * literally: "Sharing the <<renewal>> figures". They are markup in a transport that cannot
 * carry markup, and turning them back into emphasis is this component's job.
 *
 * Split rather than `dangerouslySetInnerHTML`: the snippet is message text, and handing
 * message text to the HTML parser is how a search result becomes an injection point.
 */
function highlight(snippet: string): React.ReactNode[] {
  return snippet.split(/(<<[^>]*>>)/g).map((part, index) =>
    // The index IS the identity here: the array is a positional split of one string and
    // its entries have no other stable key.
    part.startsWith('<<') && part.endsWith('>>') ? (
      <mark key={`m${index}`}>{part.slice(2, -2)}</mark>
    ) : (
      <span key={`t${index}`}>{part}</span>
    ),
  );
}

export function ConversationSearch({
  onOpenConversation,
  onSearchingChange,
  conversations = [],
  conversationId,
}: {
  readonly onOpenConversation: (conversationId: string) => void;
  /**
   * Told to the shell so the conversation list can step aside while results are up.
   *
   * Screen 04 is a result SURFACE — the list it replaces is not drawn underneath it. Left
   * in place, the panel showed results, then the All/Unread/Groups pills, then the whole
   * unfiltered list again, and the second half was noise that the eye has to scroll past
   * to reach nothing.
   *
   * It reports "searching", not "found something": a failed search keeps the list, because
   * "search is unavailable" must not also remove the way in that still works.
   */
  readonly onSearchingChange?: ((searching: boolean) => void) | undefined;
  /**
   * Narrows every query to one thread — the chat header's magnifier.
   *
   * The server has accepted a conversation scope since the route was written and no screen
   * ever sent one, so "search in this conversation" was a capability the product had and
   * could not reach. Files and people are not offered in this mode: a thread's files are
   * the information panel's Shared files, and its people are its members.
   */
  readonly conversationId?: string | undefined;
  /**
   * The threads the shell has loaded, purely so a result can name the one it came from.
   *
   * Optional and defaulted: the list is paged, so a hit in a conversation further back
   * simply renders without a thread name rather than blocking on a lookup.
   */
  readonly conversations?: readonly ConversationSummary[];
}): React.JSX.Element {
  const nameOf = (conversationId: string): string | undefined => {
    const found = conversations.find((c) => c.conversationId === conversationId);
    return found === undefined ? undefined : conversationLabel(found);
  };

  const [term, setTerm] = useState('');
  const [facet, setFacet] = useState<Facet>('all');
  const [hits, setHits] = useState<readonly SearchHit[] | undefined>();
  const [files, setFiles] = useState<readonly (SharedFile & { conversationId: string })[]>([]);
  const [people, setPeople] = useState<readonly DirectoryEntry[]>([]);
  /** Boolean, not a count — see `api.search`. True when the server found anything. */
  const [matched, setMatched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  const query = term.trim();
  const active = query.length >= MIN_LENGTH;
  const total = (hits?.length ?? 0) + files.length + people.length;
  /* "All" is the other three together — see the `Facet` note. */
  const show = (which: Facet): boolean => facet === 'all' || facet === which;

  useEffect(() => {
    if (!active) {
      setHits(undefined);
      setFiles([]);
      setPeople([]);
      setMessage(undefined);
      setBusy(false);
      return;
    }

    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      /*
         Files and people, alongside the messages — but only in the unscoped search.

         Screen 04 puts all three in one result set, and they are three different reads:
         messages through the search provider, files by name across the caller's own
         conversations, people through the directory. Each fails on its own without taking
         the others down, because "the directory is unavailable" is not a reason to show no
         messages.
      */
      if (conversationId === undefined) {
        void api
          .searchFiles(query)
          .then((result) => {
            if (!cancelled) setFiles(result.files);
          })
          .catch(() => {
            if (!cancelled) setFiles([]);
          });
        void api
          .directory(query)
          .then((result) => {
            if (!cancelled) setPeople(result.entries);
          })
          .catch(() => {
            if (!cancelled) setPeople([]);
          });
      }

      void api
        .search(query, conversationId)
        .then((result) => {
          if (cancelled) return;
          setHits(result.results);
          setMatched(result.matched);
          setMessage(undefined);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setHits(undefined);
          /**
           * §30's rate limit is a real outcome, not an error to hide: a person who
           * searches repeatedly should be told to slow down rather than shown an empty
           * result, which they would read as "nothing found".
           */
          setMessage(
            cause instanceof ApiError && cause.status === 429
              ? 'Too many searches just now. Try again in a moment.'
              : 'Search is unavailable. This is not the same as no results.',
          );
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, active, conversationId]);

  /*
     One effect, so the shell is told on the same commit the results appear on. A call from
     inside render would set state during another component's render.
  */
  const searching = active && message === undefined;
  useEffect(() => {
    onSearchingChange?.(searching);
    return () => {
      onSearchingChange?.(false);
    };
  }, [searching, onSearchingChange]);

  const clear = (): void => {
    setTerm('');
    inputRef.current?.focus();
  };

  return (
    <section className="search" aria-label="Search conversations">
      {/*
        Still a `form`, so Enter submits and the field is a labelled control in a landmark
        — but submitting only re-focuses, because the results are already there. Removing
        the form entirely would take Enter away from anyone who presses it out of habit.
      */}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <div className="field-with-clear">
          {/*
            The magnifier is inside the field, not beside it. A search box needs to be
            recognisable before it is read, and at the top of a panel — where this now
            sits — the icon is what does that recognising.
          */}
          <span className="field-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" focusable="false">
              <circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="m15.6 15.6 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <label>
            {/*
              The name is on screen twice otherwise: this label and the placeholder said
              the same words, and the pair cost a whole row in a sidebar that has to fit a
              conversation list on a phone. `sr-only` keeps it as the accessible name —
              `display: none` would take the name away with the text.
            */}
            <span className="sr-only">Search people, groups, files</span>
            <input
              ref={inputRef}
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && term !== '') {
                  e.preventDefault();
                  clear();
                }
              }}
              placeholder="Search people, groups, files"
            />
          </label>
          {term !== '' ? (
            <button
              type="button"
              className="field-clear"
              aria-label="Clear the search"
              onClick={clear}
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </div>
      </form>

      <div aria-live="polite">
        {busy ? <p className="muted result-note">Searching…</p> : null}

        {message !== undefined && !busy ? (
          <p role="alert" className="result-note result-note-error">
            {message}
          </p>
        ) : null}

        {hits !== undefined && message === undefined && !busy ? (
          <>
            {/*
              The reference's tabs, with the counts it draws on them.

              Rendered only in the unscoped search: inside one conversation there is nothing
              to filter between, and three tabs over one list is furniture. They are also
              only shown once something has been found — a row of "Messages 0 · Files 0"
              above an empty result is a worse way of saying nothing found.
            */}
            {conversationId === undefined && total > 0 ? (
              <div className="search-facets" role="tablist" aria-label="Filter results">
                {(
                  [
                    ['all', 'All', total],
                    ['messages', 'Messages', hits.length],
                    ['files', 'Files', files.length],
                    ['people', 'People', people.length],
                  ] as const
                ).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={facet === id}
                    className={`filter-pill${facet === id ? ' active' : ''}`}
                    onClick={() => setFacet(id)}
                    disabled={count === 0 && id !== 'all'}
                  >
                    {label} {count}
                  </button>
                ))}
              </div>
            ) : null}

            {/*
              FR-SRCH-4: "we looked and found nothing" must be distinguishable from "we
              could not look". A failure above renders instead of this block rather than
              alongside it.
            */}
            {total === 0 ? (
              <p className="muted result-note">
                {matched ? 'Nothing matches' : 'No results for'} “{query}”.
              </p>
            ) : null}

            {show('messages') && hits.length > 0 ? (
              <>
                <p className="search-group">Messages</p>
                <ul className="search-results">
                  {hits.map((hit) => (
                    <li key={hit.messageId}>
                      <button type="button" onClick={() => onOpenConversation(hit.conversationId)}>
                        <span className="search-avatar" aria-hidden="true">
                          {hit.senderDisplayName === undefined
                            ? '·'
                            : initialsFor(hit.senderDisplayName)}
                        </span>
                        <span className="search-text">
                          {/*
                            Who, where and when — above the fragment, as the design draws it.

                            The name and the time come from the API; the THREAD name is read
                            from the conversations the shell already holds, so it cannot
                            disagree with the sidebar and costs no request.
                          */}
                          <span className="search-context">
                            {/*
                              Who and where ellipsize; WHEN does not.

                              All three were one nowrap line, so in a 340px column the
                              timestamp was the part that fell off the end — and with five
                              hits from the same person in the same thread, the time is the
                              only thing that tells them apart.
                            */}
                            <span className="search-context-who">
                              {hit.senderDisplayName !== undefined ? (
                                <strong>{hit.senderDisplayName}</strong>
                              ) : null}
                              {nameOf(hit.conversationId) !== undefined ? (
                                <>
                                  {hit.senderDisplayName !== undefined ? ' in ' : ''}
                                  <strong>{nameOf(hit.conversationId)}</strong>
                                </>
                              ) : null}
                            </span>
                            {hit.createdAt !== undefined ? (
                              <time className="search-context-when" dateTime={hit.createdAt}>
                                {when(hit.createdAt)}
                              </time>
                            ) : null}
                          </span>
                          <span className="search-snippet">{highlight(hit.snippet)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {show('files') && files.length > 0 ? (
              <>
                <p className="search-group">Files</p>
                <ul className="search-results">
                  {files.map((file) => (
                    <li key={file.attachmentId}>
                      <button
                        type="button"
                        onClick={() => onOpenConversation(file.conversationId)}
                      >
                        <span className="search-avatar file" aria-hidden="true">
                          {extensionOf(file.filename)}
                        </span>
                        <span className="search-text">
                          <span className="search-name">{file.filename}</span>
                          <span className="search-context">
                            {file.uploadedBy !== undefined ? `Shared by ${file.uploadedBy} · ` : ''}
                            {when(file.sharedAt)} · {formatBytes(file.declaredBytes)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {show('people') && people.length > 0 ? (
              <>
                <p className="search-group">People</p>
                <ul className="search-results">
                  {people.map((person) => (
                    <li key={person.principalId}>
                      {/*
                        A person is not a conversation, so this row opens the directory
                        rather than pretending to navigate somewhere. Starting a chat from
                        here would be a second copy of the directory's own start flow, with
                        its own BR-08 check to get wrong.
                      */}
                      <button type="button" onClick={() => requestBrowseDirectory()}>
                        <span className="search-avatar" aria-hidden="true">
                          {initialsFor(person.displayName)}
                        </span>
                        <span className="search-text">
                          <span className="search-name">{person.displayName}</span>
                          <span className="search-context">
                            {[person.department, person.location].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
