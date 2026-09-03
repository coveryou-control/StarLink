'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SEARCH_MINIMUM_TERM_LENGTH } from '@starlink/shared-contracts';

import { api, ApiError, type DirectoryEntry } from '../lib/api-client';
import { initialsFor } from './conversation-naming';
import { onShellAction } from '../lib/shell-actions';
import { useSession } from './session-provider';

/**
 * Starting a conversation.
 *
 * ## Two questions, asked in order
 *
 * "One person, or several?" and then "who?". The dialog used to ask only the second and
 * infer the first from how many people you happened to pick — one colleague meant a direct
 * thread, two or more meant a group. That is tidy from the server's side and wrong from
 * the person's: a group needs a NAME, so choosing a second colleague made a new required
 * field appear underneath a form somebody thought they had finished.
 *
 * Asking first costs one click and makes the rest of the dialog honest: a chat has one
 * result row you press and you are in it; a group collects people and asks for a name from
 * the start, because it was always going to.
 *
 * §21 still decides the TYPE from the count — the mode chooses which form you get, and the
 * request says `INTERNAL_DIRECT` or `INTERNAL_GROUP` from `chosen.length`, exactly as
 * before. Nothing new is claimed to the server.
 *
 * ## The results appear as you type
 *
 * There was a Find button. Search-as-you-type is what everybody does before they look for
 * one, and a button that has to be pressed before a list can appear is a step the person
 * has already told you they want taken. Debounced, because the directory endpoint is
 * rate-limited (§27.5) and a request per keystroke spends that allowance in a second.
 */

/** Long enough that a fast typist issues one request, short enough to feel immediate. */
const DEBOUNCE_MS = 250;

type Mode = 'chat' | 'group';

export function StartConversation({
  onStarted,
}: {
  readonly onStarted: (conversationId: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode | undefined>();
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<readonly DirectoryEntry[]>([]);
  const [chosen, setChosen] = useState<readonly DirectoryEntry[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  /** Set by the first completed search, so "no matches" cannot show before one ran. */
  const [searched, setSearched] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
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

  const reset = (): void => {
    setMode(undefined);
    setTerm('');
    setFound([]);
    setChosen([]);
    setTitle('');
    setSearched(false);
    setMessage(undefined);
  };

  const close = (): void => {
    setOpen(false);
    reset();
  };

  /*
     Opened from the empty pane's "New chat" as well as from the button here — and that one
     names a mode, so it lands on the search rather than on the fork.
  */
  useEffect(
    () =>
      onShellAction({
        onNewConversation: (requested) => {
          setMode(requested);
          setOpen(true);
        },
      }),
    [],
  );

  /**
   * Escape closes the dialog — unless a request is in flight, in which case dismissing the
   * surface would leave the person with no idea whether the conversation was created.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy]);

  /* The field is the only thing to do once a mode is chosen, so it takes the caret. */
  useEffect(() => {
    if (mode !== undefined) fieldRef.current?.focus();
  }, [mode]);

  /**
   * The search itself, debounced and cancelled on the way out.
   *
   * `cancelled` matters more than the timer: a slow response for "ra" must not overwrite
   * the results for "rahul" typed while it was in flight, which is the classic
   * search-as-you-type defect and shows up as the list flickering back to a stale answer.
   */
  useEffect(() => {
    const query = term.trim();
    if (mode === undefined || query.length < SEARCH_MINIMUM_TERM_LENGTH) {
      setFound([]);
      setSearched(false);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void api
        .directory(query)
        .then(({ entries }) => {
          if (cancelled) return;
          setFound(
            entries.filter(
              (e) => e.principalId !== me && !chosen.some((c) => c.principalId === e.principalId),
            ),
          );
          setSearched(true);
          setMessage(undefined);
        })
        .catch(() => {
          if (!cancelled) setMessage('The directory is unavailable.');
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, mode, me, chosen]);

  const create = async (people: readonly DirectoryEntry[], groupTitle?: string): Promise<void> => {
    if (people.length === 0) return;
    setBusy(true);
    setMessage(undefined);
    try {
      /**
       * §21: one colleague is a DIRECT thread, more than one is a GROUP. Still derived
       * from the count rather than from the mode — the mode chose the FORM, and a group
       * of one would be a direct thread whatever the person pressed to get here.
       */
      const result = await api.createConversation({
        type: people.length === 1 ? 'INTERNAL_DIRECT' : 'INTERNAL_GROUP',
        participantIds: people.map((c) => c.principalId),
        ...(groupTitle !== undefined && groupTitle.trim() !== '' ? { title: groupTitle.trim() } : {}),
      });

      close();
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
        The accessible name is still exactly "New conversation". Only the visible label is
        a glyph. A test that finds this button by name — and `responsive.spec.ts` does, at
        every width down to 320px — finds the same button it always did.
      */
      aria-label="New conversation"
    >
      {/*
        A speech bubble with a plus in it, not a bare plus.

        A plus on its own is the universal "add", and in a column of conversations it read
        as a box with a cross in it — it says something will be created and not what. The
        bubble says the noun and the plus says the verb, which is the icon every messenger
        uses for this and the one people recognise without reading a tooltip.
      */}
      <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false">
        <path
          d="M20.5 11.3c0 4-3.8 7.2-8.5 7.2a10 10 0 0 1-2.7-.36L4.6 20l1.25-3.4A6.8 6.8 0 0 1 3.5 11.3c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path
          d="M12 8.6v5.2M9.4 11.2h5.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );

  if (!open) return trigger;

  const canCreateGroup = chosen.length > 1 && title.trim() !== '';

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
      */}
      {createPortal(
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!busy) close();
          }}
        >
          <section
            className="start-panel"
            aria-label="Start a conversation"
            /* The panel is inside the backdrop, so a click that lands on the form would
               bubble up and close the dialog the person is filling in. */
            onClick={(event) => event.stopPropagation()}
          >
            <div className="start-panel-head">
              <h2>
                {mode === undefined ? 'New conversation' : mode === 'chat' ? 'New chat' : 'New group'}
              </h2>
              <button
                type="button"
                className="start-panel-close"
                onClick={close}
                disabled={busy}
                aria-label="Close"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            {mode === undefined ? (
              /*
                The fork. Two rows rather than a segmented control: each is a destination
                with a sentence explaining what you get, and a segmented control would make
                them look like a setting on a form that is not there yet.
              */
              <ul className="start-modes">
                <li>
                  <button type="button" className="start-mode" onClick={() => setMode('chat')}>
                    <span className="start-mode-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20">
                        <circle cx="12" cy="8.2" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
                        <path
                          d="M5 19.2c0-3.2 3.1-5.2 7-5.2s7 2 7 5.2"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                        />
                      </svg>
                    </span>
                    {/*
                      The label alone. It had a line of explanation under it — "One
                      colleague, one thread" — and a two-item choice between "chat" and
                      "group" does not need either of them defined. A subtitle that restates
                      the noun above it is furniture that makes the row taller and the
                      decision no easier.
                    */}
                    <span className="start-mode-text">
                      <strong>New chat</strong>
                    </span>
                  </button>
                </li>
                <li>
                  <button type="button" className="start-mode" onClick={() => setMode('group')}>
                    <span className="start-mode-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20">
                        <circle cx="9" cy="8.4" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
                        <path
                          d="M2.8 19c0-3 2.8-4.8 6.2-4.8s6.2 1.8 6.2 4.8"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                        />
                        <path
                          d="M16.4 5.6a3.2 3.2 0 0 1 0 5.7M18 14.6c2 .6 3.4 2.1 3.4 4.4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                        />
                      </svg>
                    </span>
                    <span className="start-mode-text">
                      <strong>New group</strong>
                    </span>
                  </button>
                </li>
              </ul>
            ) : (
              <>
                {/*
                  The chosen people sit ABOVE the search, as removable chips, the way every
                  recipient field works. Below the results they would read as an outcome of
                  the search rather than as the thing being assembled.

                  Only in a group: a chat is one person and choosing them is the last act.
                */}
                {chosen.length > 0 ? (
                  <ul className="chosen" aria-label="Chosen colleagues">
                    {chosen.map((c) => (
                      <li key={c.principalId}>
                        <span>{c.displayName}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${c.displayName}`}
                          onClick={() =>
                            setChosen((was) => was.filter((x) => x.principalId !== c.principalId))
                          }
                        >
                          <span aria-hidden="true">×</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="start-search">
                  <label>
                    {/*
                      `sr-only`: the placeholder says the same thing on screen, and a
                      visible label above the field cost a row in a panel that already
                      stacks several. The span keeps the input's accessible name, which a
                      placeholder alone does not.
                    */}
                    <span className="sr-only">
                      {mode === 'chat' ? 'Who do you want to talk to?' : 'Who is in this group?'}
                    </span>
                    <input
                      ref={fieldRef}
                      type="search"
                      value={term}
                      onChange={(e) => setTerm(e.target.value)}
                      placeholder="Search by name, department or ID"
                      autoComplete="off"
                    />
                  </label>
                </div>

                {/*
                  A person is a row, not a line of text: avatar, name, department. The same
                  shape as the People panel, because they are the same thing and looking
                  different would make them feel like different features.

                  In a chat the row STARTS the conversation. There is nothing else to
                  decide, so a second press on a "Start" button would be the product asking
                  a question it already has the answer to.
                */}
                <ul className="people-list found" aria-live="polite">
                  {found.map((entry) => (
                    <li key={entry.principalId}>
                      <button
                        type="button"
                        className="person-row"
                        disabled={busy}
                        onClick={() => {
                          if (mode === 'chat') {
                            void create([entry]);
                            return;
                          }
                          setChosen((was) => [...was, entry]);
                          setFound((was) =>
                            was.filter((x) => x.principalId !== entry.principalId),
                          );
                          setTerm('');
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
                              INTEGRATION_CONTRACTS §1 rule 4: an interim identity source
                              must never be mistakable for a canonical one. The directory
                              says so, and so does this.
                            */}
                            {entry.authority !== 'CANONICAL' ? (
                              <span
                                className="provisional"
                                title="Directory data is interim (HRMS pending)"
                              >
                                {' · interim'}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="person-action" aria-hidden="true">
                          {mode === 'chat' ? 'Chat' : 'Add'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>

                {/*
                  Two states, and they are not the same thing: "nothing matches" is an
                  answer and "still looking" is not.

                  There was a third — a line telling somebody to start typing, under an
                  empty field whose placeholder already said "Search by name, department or
                  ID". Instructions for a control that is explaining itself.
                */}
                {searching && found.length === 0 ? (
                  <p className="muted result-note">Searching…</p>
                ) : null}
                {searched && !searching && found.length === 0 && message === undefined ? (
                  <p className="muted result-note">No colleague matches that.</p>
                ) : null}
                {/*
                  A group needs a name, asked for once there is a group to name.

                  It was on screen from the moment the mode was chosen, which put an empty
                  required field above an empty member list — the form asking for the last
                  answer before the first. Every phone messenger collects the people and
                  then names them, and it reads as one step following another rather than
                  as a form to fill in.

                  `createInternalConversation` refuses a group without a title
                  (`TITLE_REQUIRED_FOR_GROUP`), and that refusal used to surface as "check
                  the colleagues you chose" — which blames the one part of the form that was
                  correct. The button below stays disabled until the field is filled, so the
                  rule is visible before the request rather than after it.
                */}
                {mode === 'group' && chosen.length > 0 ? (
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
                  {mode === 'group' ? (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void create(chosen, title)}
                      disabled={busy || !canCreateGroup}
                    >
                      {busy ? 'Creating…' : 'Create group'}
                    </button>
                  ) : null}
                  {/* Back, not Cancel: the fork is one press away and losing a half-typed
                      search to get to it would be the dialog punishing a change of mind. */}
                  <button type="button" onClick={() => { reset(); }} disabled={busy}>
                    Back
                  </button>
                </div>
              </>
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
