'use client';

/**
 * Choosing the colleague a conversation moves to (SL-042, SL-043, SL-039).
 *
 * ## The defect this replaces
 *
 * Transfer, escalate and arrange-cover all need a `principalId`, and the form asked for it
 * with a bare text input placeholdered `principal id`. Every one of those endpoints was
 * built, guarded and tested — and no agent could use any of them, because nobody knows a
 * colleague's UUID. The API existed; the user path did not.
 *
 * The directory search it needed was already there (`GET /v1/employee/directory`, SL-081's
 * neighbour) with a component browsing it in the sidebar. Only the wire between them was
 * missing.
 *
 * ## Why the name is shown back
 *
 * §21.9 and BR-15 make the reason part of the act, and the act is "give this to *Priya*",
 * not "give this to 018f2c5a…". Once chosen, this renders the person — so the agent
 * confirms a human being before committing, and a mis-click is visible rather than
 * encoded. The id still travels to the API unchanged; nothing about the contract moves.
 *
 * A two-character minimum is the server's rule (FR-SRCH-5: "a one-character search is a
 * request for the entire staff list wearing a search's clothes"), mirrored here so the
 * refusal is explained before it is spent.
 */
import { useState } from 'react';
import { SEARCH_MINIMUM_TERM_LENGTH } from '@starlink/shared-contracts';

import { api, ApiError, type DirectoryEntry } from '../lib/api-client';

export function ColleaguePicker({
  selected,
  onSelect,
}: {
  /** The chosen colleague, or undefined while none is chosen. */
  readonly selected: DirectoryEntry | undefined;
  readonly onSelect: (entry: DirectoryEntry | undefined) => void;
}): React.JSX.Element {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<readonly DirectoryEntry[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const search = async (): Promise<void> => {
    const query = term.trim();
    /* The server's floor. It said two, and said so in a message the person then had to act
       on; the endpoint accepts one now, so the only term this can refuse is an empty one —
       and an empty box needs no sentence explaining itself. */
    if (query.length < SEARCH_MINIMUM_TERM_LENGTH) {
      setMessage(undefined);
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const found = await api.directory(query);
      setResults(found.entries);
      if (found.entries.length === 0) setMessage('Nobody matched that.');
    } catch (cause) {
      // A failed lookup must not read as "this person does not exist" — that is the one
      // reading that would make an agent give up on a colleague who is simply not indexed.
      setResults(undefined);
      setMessage(
        cause instanceof ApiError && cause.isRefusal
          ? 'The directory is not available to you.'
          : 'The directory could not be reached. This is not the same as no matches.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (selected !== undefined) {
    return (
      <div className="picker-chosen" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <span>
          Colleague: <strong>{selected.displayName}</strong>
          {selected.department !== '' ? <span className="muted"> · {selected.department}</span> : null}
        </span>
        <button
          type="button"
          onClick={() => {
            onSelect(undefined);
            setResults(undefined);
            setMessage(undefined);
          }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="picker" style={{ marginTop: 8 }}>
      <label htmlFor="colleague-search">Colleague</label>
      <div className="picker-search" style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <input
          id="colleague-search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          /* Enter searches rather than submitting the surrounding action form, which
             would fire the transfer before anyone had been chosen. */
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void search();
            }
          }}
          placeholder="Search by name"
          autoComplete="off"
        />
        <button type="button" onClick={() => void search()} disabled={busy || term.trim().length < SEARCH_MINIMUM_TERM_LENGTH}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>

      {message !== undefined ? <p role="status">{message}</p> : null}

      {results !== undefined && results.length > 0 ? (
        <ul
          className="picker-results"
          aria-label="Directory matches"
          style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, maxHeight: 180, overflowY: 'auto' }}
        >
          {results.map((entry) => (
            <li key={entry.principalId}>
              <button
                type="button"
                onClick={() => onSelect(entry)}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', textAlign: 'left', gap: 2 }}
              >
                <span>{entry.displayName}</span>
                {/* Department and team disambiguate two people with the same name; the
                    id never appears, because it is not what a person recognises. */}
                <span className="muted">
                  {[entry.department, ...entry.teams.map((t) => t.displayName)]
                    .filter((part) => part !== '')
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
