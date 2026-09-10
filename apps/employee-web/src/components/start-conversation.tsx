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
  openSignal,
}: {
  readonly onStarted: (conversationId: string) => void;
  /**
   * A counter the shell increments to open this from somewhere else.
   *
   * A counter rather than a boolean, because the caller is not tracking whether the picker
   * is currently open and should not have to: "open it" is an event, and a boolean would
   * need resetting after every use or the second press would do nothing.
   */
  readonly openSignal?: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  /*
     A TAB, not a fork you have to get past.

     This opened on a two-item chooser — "New chat" / "New group" — and only then showed a
     search. Two of the three steps were the product asking which of two words you meant
     before letting you look anybody up, and the answer is almost always the first one. The
     tabs sit above a list that is there from the moment the dialog opens, so choosing a
     person is the first act and switching to a group is a change of mind rather than a
     prerequisite.
  */
  const [mode, setMode] = useState<Mode>('chat');
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<readonly DirectoryEntry[]>([]);
  const [chosen, setChosen] = useState<readonly DirectoryEntry[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  /** Set by the first completed search, so "no matches" cannot show before one ran. */
  const [searched, setSearched] = useState(false);
  /**
   * The people shown before anybody types: the caller's own team.
   *
   * The directory REFUSES an empty term (FR-SRCH-5) — "the list is not a thing this
   * endpoint hands out" — so a picker cannot open on the whole company, and it should not:
   * an unbounded staff dump is the cheapest reconnaissance there is. `listColleagues` is
   * the bounded, already-sanctioned answer to "who can I talk to", and it is what the
   * Connect panel shows for the same reason.
   */
  const [colleagues, setColleagues] = useState<readonly DirectoryEntry[]>([]);
  const [loadingColleagues, setLoadingColleagues] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  /** The dialog itself, so focus can be moved into it when it opens. */
  const panelRef = useRef<HTMLElement>(null);
  const lastSignal = useRef(openSignal);
  useEffect(() => {
    if (openSignal === undefined || openSignal === lastSignal.current) return;
    lastSignal.current = openSignal;
    setOpen(true);
  }, [openSignal]);
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
    setMode('chat');
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
     Opened from the empty pane's "New chat" as well as from the button here. A caller that
     names a mode selects that tab; one that does not gets the default, which is a chat.
  */
  useEffect(
    () =>
      onShellAction({
        onNewConversation: (requested) => {
          setMode(requested ?? 'chat');
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

  /*
     The caller's own team, loaded once per opening.

     Not on mount: the dialog is mounted for the life of the shell and this would then be a
     request on every sign-in for a panel most sessions never open.
  */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingColleagues(true);
    void api
      .colleagues()
      .then((result) => {
        if (!cancelled) setColleagues(result.entries.filter((c) => c.principalId !== me));
      })
      .catch(() => {
        /* The search still works. An empty opening list is a worse dialog, not a broken
           one, and saying "the directory is unavailable" over a field that functions would
           be the louder lie. */
        if (!cancelled) setColleagues([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingColleagues(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, me]);

  /* The field is the only thing to do once a mode is chosen, so it takes the caret. */
  useEffect(() => {
    if (mode !== undefined) fieldRef.current?.focus();
  }, [mode]);

  /**
   * On OPEN, before a mode is chosen, focus moves into the dialog anyway.
   *
   * The effect above only fires once somebody picks "New chat" or "New group", so the
   * first screen — the chooser — left focus on the button that opened the dialog. A
   * keyboard user then tabbed forwards from the sidebar and walked the page BEHIND the
   * blur before ever reaching the dialog, and a screen reader was told a dialog existed
   * while the caret was still outside it.
   *
   * The first focusable thing inside, EXCEPT the close button. It is first in the DOM, and
   * landing on it means the first key a keyboard user presses dismisses the dialog they
   * just opened. The chooser's buttons are what somebody is actually being asked to decide
   * between, so the first of those is the landing place — and it stays right if the panel
   * later gains a control above them.
   */
  useEffect(() => {
    if (!open || mode !== undefined) return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const target = [...(focusable ?? [])].find(
      (element) => !element.classList.contains('start-panel-close'),
    );
    (target ?? focusable?.[0])?.focus();
  }, [open, mode]);

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
            ref={panelRef}
            className="start-panel"
            /*
               The one modal in the product that never said it was one.
               
               It moves focus to the search field and closes on Escape, so it BEHAVES like a
               dialog — but with no `role`, a screen reader announced a section and never
               told the person a dialog had opened. Every other modal here declares it;
               `confirm-dialog` correctly uses `alertdialog`, which is the stronger form for
               something demanding a decision.
            */
            role="dialog"
            aria-modal="true"
            aria-labelledby="start-panel-title"
            /* The panel is inside the backdrop, so a click that lands on the form would
               bubble up and close the dialog the person is filling in. */
            onClick={(event) => event.stopPropagation()}
          >
            {/*
              A titled header with the close at its far RIGHT.

              Three things were wrong with what this replaces, and they compounded. There was
              no title, so the tab labels were doing double duty as the dialog's name — which
              is why "New chat" read as a heading and as a control at the same time. The close
              sat immediately after the tabs, mid-header, where every other dialog in the
              product puts it in the corner. And with nothing between the header and the
              field, the panel had no structure at all: three unrelated things stacked in a
              white box.
            */}
            <header className="start-panel-head">
              <h2 id="start-panel-title">New conversation</h2>
              <button
                type="button"
                className="start-panel-close"
                onClick={close}
                disabled={busy}
                aria-label="Close"
              >
                {/* Drawn, not the `×` character, which renders at whatever weight the body
                    font gives it — a hairline at 20px in this typeface. */}
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                  <path
                    d="m6.5 6.5 11 11m0-11-11 11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </header>

            {/*
              Tabs, so the two destinations are visible at once and switching between them
              costs nothing. The chooser they replace made "which of these two words did
              you mean" a step you had to finish before the product would show you a
              single colleague.

              Below the header now rather than inside it: they are a choice WITHIN the
              dialog, not its name.
            */}
            <div className="start-tabs" role="tablist" aria-label="What to start">
              {(['chat', 'group'] as const).map((which) => (
                <button
                  key={which}
                  type="button"
                  role="tab"
                  aria-selected={mode === which}
                  className={mode === which ? 'active' : undefined}
                  disabled={busy}
                  onClick={() => setMode(which)}
                >
                  {which === 'chat' ? 'Chat with one person' : 'Group'}
                </button>
              ))}
            </div>

            {/*
              The group's NAME comes first, above the people.

              It used to appear only once somebody had been added, which meant the field
              asked for last was the one blocking the button — with an empty name and two
              members chosen, "Create group" sat disabled with nothing on screen saying why.
              Asking for it up front makes the requirement visible before it can refuse
              anything.
            */}
            {mode === 'group' ? (
              <label className="stacked-field start-group-name">
                <span className="sr-only">Group name</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  placeholder="Group name"
                  required
                />
              </label>
            ) : null}

            {/*
              The chosen people sit ABOVE the search, as removable chips, the way every
              recipient field works. Below the results they would read as an outcome of the
              search rather than as the thing being assembled.
            */}
            {mode === 'group' && chosen.length > 0 ? (
              <ul className="chosen" aria-label="Chosen colleagues">
                {chosen.map((c) => (
                  <li key={c.principalId}>
                    <span className="chosen-avatar" aria-hidden="true">
                      {initialsFor(c.displayName)}
                    </span>
                    <span>{c.displayName.split(' ')[0]}</span>
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
                {/* `sr-only`: the placeholder says the same thing on screen, and a visible
                    label above the field cost a row in a panel that already stacks several.
                    The span keeps the input's accessible name, which a placeholder alone
                    does not. */}
                <span className="sr-only">
                  {mode === 'chat' ? 'Who do you want to talk to?' : 'Who is in this group?'}
                </span>
                <input
                  ref={fieldRef}
                  type="search"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="Search name or @username…"
                  autoComplete="off"
                />
              </label>
            </div>

            {/*
              People, from the moment the dialog opens.

              Before anybody types this is the caller's own team — the directory refuses an
              empty term (FR-SRCH-5) and should, so the opening list is the bounded set
              `listColleagues` already hands out. Typing switches to the search.
            */}
            <ul className="people-list found" aria-live="polite">
              {(term.trim() === '' ? colleagues : found).map((entry) => {
                const picked = chosen.some((c) => c.principalId === entry.principalId);
                return (
                  <li key={entry.principalId}>
                    <button
                      type="button"
                      className={`person-row${picked ? ' picked' : ''}`}
                      disabled={busy}
                      aria-pressed={mode === 'group' ? picked : undefined}
                      onClick={() => {
                        if (mode === 'chat') {
                          void create([entry]);
                          return;
                        }
                        /* A row TOGGLES in a group. Pressing an added person again used to
                           do nothing, because the row left the results the moment it was
                           chosen — so undoing meant hunting for the chip. */
                        setChosen((was) =>
                          was.some((c) => c.principalId === entry.principalId)
                            ? was.filter((c) => c.principalId !== entry.principalId)
                            : [...was, entry],
                        );
                      }}
                    >
                      <span className="row-avatar" aria-hidden="true">
                        {initialsFor(entry.displayName)}
                      </span>
                      <span className="person-text">
                        <span className="person-name">{entry.displayName}</span>
                        <span className="person-meta">
                          {/* The handle, because it is what tells two people with the same
                              name apart and what the field above offers to match. The
                              department is the fallback for a directory with none. */}
                          {entry.username !== undefined ? `@${entry.username}` : entry.department}
                          {/* INTEGRATION_CONTRACTS §1 rule 4: an interim identity source must
                              never be mistakable for a canonical one. */}
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
                      {mode === 'group' ? (
                        <span className={`person-check${picked ? ' on' : ''}`} aria-hidden="true">
                          {picked ? (
                            <svg viewBox="0 0 24 24" width="13" height="13" focusable="false">
                              <path
                                d="M5 12.5l4.5 4.5L19 7.5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : null}
                        </span>
                      ) : (
                        <span className="person-action" aria-hidden="true">
                          Chat
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/*
              Four states, and they are not the same thing: the team is still loading, the
              team is genuinely empty, a search is running, a search found nothing.
            */}
            {term.trim() === '' && loadingColleagues && colleagues.length === 0 ? (
              <ul className="people-list" aria-hidden="true">
                {[0, 1, 2, 3].map((n) => (
                  <li key={n}>
                    <span className="person-row skeleton-row">
                      <span className="skeleton skeleton-avatar" />
                      <span className="skeleton-lines">
                        <span className="skeleton skeleton-line" />
                        <span className="skeleton skeleton-line short" />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {term.trim() === '' && !loadingColleagues && colleagues.length === 0 ? (
              /*
                 The old line read "Nobody in your team yet", which is a claim about the
                 company and usually a false one — it means only that the CALLER's team has
                 no other members recorded, which is the ordinary state of a new joiner and
                 of anybody the directory has not placed on a team yet. It sounded like the
                 product was empty.

                 What is actually true is that this list is a shortcut, not the directory:
                 everybody is reachable, by name or by handle.
              */
              <p className="muted result-note">
                Start typing to find anyone in the company — by name, or by @username.
              </p>
            ) : null}
            {searching && found.length === 0 ? (
              <p className="muted result-note">Searching…</p>
            ) : null}
            {term.trim() !== '' &&
            searched &&
            !searching &&
            found.length === 0 &&
            message === undefined ? (
              <p className="muted result-note">No colleague matches that.</p>
            ) : null}

            {message !== undefined ? (
              <p role="alert" className="result-note result-note-error">
                {message}
              </p>
            ) : null}

            {/*
              A group's foot: what you have chosen, and the one action. A chat has neither —
              pressing a person IS the action, and a second button would be the product
              asking a question it already has the answer to.
            */}
            {mode === 'group' ? (
              <div className="start-panel-foot">
                {/*
                  The foot says what is STOPPING you, not what you have done.

                  It used to read "2 selected" while the button beside it was disabled
                  because the group had no name — so the sentence said "ready" and the
                  control said "no", and the person was left pressing a dead button with the
                  screen apparently agreeing with them. Reported from use on 2026-09-10 as
                  "not able to click on create group? why so?", which is exactly the question
                  the foot was failing to answer.

                  The name field was moved to the top of the panel once already, for this
                  same defect, with a note saying it made the requirement visible before it
                  could refuse anything. Being visible and being STATED are not the same
                  thing: an empty box does not say it is mandatory.

                  So the blocking condition is named, in the order it blocks, and only the
                  ready state reports a count — because at that point the count is the only
                  thing left worth saying.
                */}
                <span className={canCreateGroup ? 'muted' : 'start-blocked'}>
                  {chosen.length < 2
                    ? 'Choose at least two people'
                    : title.trim() === ''
                      ? 'Name this group to create it'
                      : `${chosen.length} selected`}
                </span>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void create(chosen, title)}
                  disabled={busy || !canCreateGroup}
                >
                  {busy ? 'Creating…' : 'Create group'}
                </button>
              </div>
            ) : null}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
