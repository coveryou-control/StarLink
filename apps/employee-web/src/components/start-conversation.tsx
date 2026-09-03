'use client';

/**
 * Starting an internal conversation (SL-001, SL-002).
 *
 * The CSV's acceptance for SL-001 is "Send/read/history/reconnect pass" and for SL-002
 * "Group membership + history rules enforced". All of that worked — for a conversation you
 * were already in. **There was no way to begin one.** `POST /v1/employee/conversations`
 * had been built, guarded and tested since Phase 2, and no screen called it; an employee
 * opening StarLink for the first time saw an empty list and no button.
 *
 * ## One control, two conversation types
 *
 * §21 treats a 1:1 and a group as the same object with a different participant count, and
 * BR-05 makes a 1:1 idempotent — asking twice returns the existing thread. So the type is
 * derived from how many colleagues were chosen rather than asked as a separate question,
 * and the `existing` flag is used to navigate rather than to report an error.
 *
 * ## What it does not do
 *
 * It does not create a CUSTOMER conversation. Those begin when a customer arrives (§21.5),
 * never by an employee opening one on their behalf — the API's own schema admits only
 * `INTERNAL_DIRECT` and `INTERNAL_GROUP`, and offering more here would be offering
 * something the server will refuse.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { initialsFor } from './conversation-naming';
import { useSession } from './session-provider';
import { onShellAction } from '../lib/shell-actions';
import { api, ApiError, type DirectoryEntry } from '../lib/api-client';

export function StartConversation({
  onStarted,
}: {
  readonly onStarted: (conversationId: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<readonly DirectoryEntry[]>([]);
  const [chosen, setChosen] = useState<readonly DirectoryEntry[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  /** Set by the first completed search, so "no matches" cannot show before one ran. */
  const [searched, setSearched] = useState(false);
  const { state } = useSession();
  /**
   * Yourself, excluded from the results.
   *
   * The directory endpoint returns the caller along with everybody else, so searching your
   * own team listed you as a colleague to add — and adding yourself made the server refuse
   * the whole conversation with "That could not be started. Check the colleagues you
   * chose", which names the symptom and not the cause. You are already in every
   * conversation you start.
   */
  const me = state.status === 'SIGNED_IN' ? state.me.principalId : undefined;

  /**
   * Escape closes the dialog — unless a request is in flight, in which case dismissing the
   * surface would leave the person with no idea whether the conversation was created.
   */
  /* Opened from the empty pane's "New chat" as well as from the button here. */
  useEffect(() => onShellAction({ onNewConversation: () => setOpen(true) }), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy]);

  const search = async (): Promise<void> => {
    if (term.trim() === '') return;
    try {
      const { entries } = await api.directory(term.trim());
      // Someone already chosen is filtered out rather than shown as a duplicate row.
      setFound(
        entries.filter(
          (e) => e.principalId !== me && !chosen.some((c) => c.principalId === e.principalId),
        ),
      );
      setSearched(true);
    } catch {
      setMessage('The directory is unavailable.');
    }
  };

  const start = async (): Promise<void> => {
    if (chosen.length === 0) return;
    setBusy(true);
    setMessage(undefined);
    try {
      /**
       * §21: one colleague is a DIRECT thread, more than one is a GROUP. Derived rather
       * than asked — a person choosing two colleagues has already said what they want,
       * and a second question about "type" would be the product's vocabulary, not theirs.
       */
      const result = await api.createConversation({
        type: chosen.length === 1 ? 'INTERNAL_DIRECT' : 'INTERNAL_GROUP',
        participantIds: chosen.map((c) => c.principalId),
        ...(title.trim() !== '' ? { title: title.trim() } : {}),
      });

      setOpen(false);
      setChosen([]);
      setTerm('');
      setFound([]);
      setTitle('');
      // BR-05: a repeated 1:1 returns the thread that already exists. Navigating to it is
      // the right answer; reporting "already exists" would be telling the person off for
      // doing exactly what they meant.
      onStarted(result.conversationId);
    } catch (cause) {
      setMessage(
        cause instanceof ApiError && cause.isRefusal
          ? 'That could not be started. Check the colleagues you chose.'
          : 'That did not go through. Nothing was created.',
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * The trigger is always rendered; the modal is drawn over it.
   *
   * Returning one OR the other made the control disappear the moment it was used, which is
   * fine while a full-screen sheet covers it and wrong the instant the sheet is dismissed
   * by anything other than this component's own state.
   */
  const trigger = (
    <button
      type="button"
      className="fab-new"
      onClick={() => setOpen(true)}
      /*
        The accessible name is still exactly "New conversation". Only the visible label
        became a glyph: the control did not change, its prominence did. A test that finds
        this button by name — and `responsive.spec.ts` does, at every width down to 320px —
        finds the same button it always did.
      */
      aria-label="New conversation"
    >
      {/* A plus, as the design draws it — a pencil says "write", and this opens a picker. */}
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path
          d="M12 4.5v15M4.5 12h15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );

  if (!open) return trigger;

  return (
    <>
      {trigger}
      {/*
        A modal, not a panel that expands in the column.

        This used to grow in place at the top of the sidebar, pushing the conversation list
        down the screen while somebody searched the directory. Starting a conversation is a
        task with a beginning and an end, so it gets a surface of its own that closes when
        the task does — and the list it is about stays where it was.

        Dismissed by the backdrop and by Escape, both: a dialog that closes only one way is
        one somebody gets stuck in, and Escape is what a keyboard user tries first.

        Rendered through a PORTAL to `document.body`, for structure rather than for a bug:
        in place it is a `position: fixed` child of `.sidebar`, which sets
        `overflow: hidden` so the conversation list can scroll inside it, and the modal
        would then depend on that ancestor never acquiring a `transform`, `filter` or
        `contain` — any of which would make the sidebar its containing block and shrink a
        full-screen dialog to a 364px column. Nothing in the sheet does that today. The
        portal means nothing in the sheet ever can.

        Stated because it would be easy to write this up as a fix: it is not one. It was
        checked before the change — the backdrop measured the full viewport and sampling
        the rendered pixels showed the sidebar dimmed to (158,157,161) from white, which
        is exactly the 42% scrim. It looked undimmed in a scaled-down screenshot and was
        not.
      */}
      {createPortal(
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!busy) setOpen(false);
          }}
        >
    <section
      className="start-panel"
      aria-label="Start a conversation"
      /* The panel is inside the backdrop, so a click that lands on the form would bubble
         up and close the dialog the person is filling in. */
      onClick={(event) => event.stopPropagation()}
    >
      <div className="start-panel-head">
        <h2>New conversation</h2>
        <button
          type="button"
          className="start-panel-close"
          onClick={() => setOpen(false)}
          disabled={busy}
          aria-label="Close"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      {/*
        The chosen people sit ABOVE the search, as removable chips, the way every
        recipient field works. Below the results they read as an outcome of the search
        rather than as the thing being assembled.
      */}
      {chosen.length > 0 ? (
        <ul className="chosen" aria-label="Chosen colleagues">
          {chosen.map((c) => (
            <li key={c.principalId}>
              <span>{c.displayName}</span>
              <button
                type="button"
                aria-label={`Remove ${c.displayName}`}
                onClick={() => setChosen((was) => was.filter((x) => x.principalId !== c.principalId))}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label>
          {/*
            `sr-only`: the placeholder says the same thing on screen, and a visible label
            above the field cost a row in a panel that already stacks four of them. The
            span keeps the input's accessible name, which a placeholder alone does not.
          */}
          <span className="sr-only">Who do you want to talk to?</span>
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search by name, department or ID"
          />
        </label>
        <button type="submit">Find</button>
      </form>

      {/*
        A person is a row, not a line of text: avatar, name, department. The same shape as
        the directory below, because they are the same thing and looking different would
        make them feel like different features.
      */}
      <ul className="people-list found">
        {found.map((entry) => (
          <li key={entry.principalId}>
            <button
              type="button"
              className="person-row"
              onClick={() => {
                setChosen((was) => [...was, entry]);
                setFound((was) => was.filter((x) => x.principalId !== entry.principalId));
              }}
            >
              <span className="row-avatar" aria-hidden="true">
                {initialsFor(entry.displayName)}
              </span>
              <span className="person-text">
                <span className="person-name">{entry.displayName}</span>
                <span className="person-meta">
                  {entry.department}
                  {/*
                    INTEGRATION_CONTRACTS §1 rule 4: an interim identity source must never
                    be mistakable for a canonical one. The directory says so, and so does
                    this.
                  */}
                  {entry.authority !== 'CANONICAL' ? (
                    <span className="provisional" title="Directory data is interim (HRMS pending)">
                      {' · interim'}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="person-action" aria-hidden="true">
                Add
              </span>
            </button>
          </li>
        ))}
      </ul>

      {searched && found.length === 0 && message === undefined ? (
        <p className="muted result-note">No colleague matches that.</p>
      ) : null}

      {/*
        A group needs a name; a 1:1 does not, and asking for one would be noise.

        NOT "(optional)", which is what this said. `createInternalConversation` refuses a
        group without a title (`TITLE_REQUIRED_FOR_GROUP`), so the label was describing a
        rule the opposite of the one the server enforces — and the refusal surfaced as
        "check the colleagues you chose", which blames the one part of the form that was
        correct. The Start button below is disabled until it is filled, so the rule is
        visible before the request rather than after it.
      */}
      {chosen.length > 1 ? (
        <label className="stacked-field">
          <span>Name this group</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="Q3 renewals huddle"
            required
          />
        </label>
      ) : null}

      {message !== undefined ? (
        <p role="alert" className="result-note result-note-error">
          {message}
        </p>
      ) : null}

      <div className="start-panel-buttons">
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || chosen.length === 0 || (chosen.length > 1 && title.trim() === '')}
        >
          {busy ? 'Starting…' : chosen.length > 1 ? 'Start group' : 'Start conversation'}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
        </div>,
        document.body,
      )}
    </>
  );
}
