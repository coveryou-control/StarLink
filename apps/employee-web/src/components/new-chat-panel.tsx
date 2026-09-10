'use client';

/**
 * Starting a conversation, as a PANEL over the list rather than a dialog over the page.
 *
 * ## Why it stopped being a modal
 *
 * It was a centred card on a dimmed page, and the note above the old version argued for
 * that: starting a conversation is a task with a beginning and an end, so it gets a
 * surface of its own. The argument holds; the surface was wrong. A modal over the whole
 * product to pick a colleague dims the thread you are reading to ask a question about the
 * column beside it, and it reads as a form the product put in front of you rather than as
 * a place you went.
 *
 * The panel slides over the LIST, which is the column the answer belongs to — the new
 * conversation appears there — and the thread stays visible and readable behind it. It is
 * what every messenger does and it is a smaller claim on the screen for the same task.
 *
 * ## Three steps, and why a group has two of them
 *
 * `chat` is one step: search, press a person, you are in the conversation.
 *
 * A group is `members` then `name`, and splitting them fixed a real complaint. Both were
 * one screen with a name field at the top, and somebody choosing people met a disabled
 * "Create group" with an empty box above it — reported as "not able to click on create
 * group? why so?". A step that collects people and then asks for a name cannot present a
 * dead button, because each step has exactly one thing to do and its control says which.
 *
 * The blocked-reason line from that fix is kept anyway, on the members step: "Choose at
 * least two people" is still a real state, and naming it is still better than a disabled
 * arrow.
 *
 * ## What is NOT offered
 *
 * WhatsApp's equivalent lists "New contact" and "New community" beside "New group". There
 * is no such thing here and there will not be: employees come from HRMS through the
 * identity adapter (rule 11), so there is no contact for anybody to add — everyone is
 * already reachable, which is what the search says when the team list is empty.
 */
import { useEffect, useRef, useState } from 'react';
import { SEARCH_MINIMUM_TERM_LENGTH } from '@starlink/shared-contracts';

import { api, ApiError, type DirectoryEntry } from '../lib/api-client';
import { AvatarImage } from './avatar-image';
import { initialsFor } from './conversation-naming';
import { distinctIdentityHues, identityStyleFrom } from '../lib/identity-colour';
import { useSession } from './session-provider';

/** Long enough that a fast typist issues one request, short enough to feel immediate. */
const DEBOUNCE_MS = 250;

type Step = 'chat' | 'members' | 'name';

export function NewChatPanel({
  startAs,
  onClose,
  onStarted,
}: {
  /** Which step to open on. The rail's "New chat" opens the chat step. */
  readonly startAs?: 'chat' | 'group';
  readonly onClose: () => void;
  readonly onStarted: (conversationId: string) => void;
}): React.JSX.Element {
  const { state } = useSession();
  const me = state.status === 'SIGNED_IN' ? state.me.principalId : undefined;

  const [step, setStep] = useState<Step>(startAs === 'group' ? 'members' : 'chat');
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<readonly DirectoryEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [colleagues, setColleagues] = useState<readonly DirectoryEntry[]>([]);
  const [loadingColleagues, setLoadingColleagues] = useState(true);
  const [chosen, setChosen] = useState<readonly DirectoryEntry[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const fieldRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
     The caller's own team, loaded once. The directory REFUSES an empty term (FR-SRCH-5)
     and should: an unbounded staff dump is the cheapest reconnaissance there is.
     `listColleagues` is the bounded, already-sanctioned answer to "who can I talk to".
  */
  useEffect(() => {
    let cancelled = false;
    void api
      .colleagues()
      .then((result) => {
        if (!cancelled) setColleagues(result.entries.filter((c) => c.principalId !== me));
      })
      .catch(() => {
        /* The search still works. An empty opening list is a worse panel, not a broken
           one, and saying "the directory is unavailable" over a field that functions
           would be the louder lie. */
        if (!cancelled) setColleagues([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingColleagues(false);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  /* Search as you type, debounced — the directory endpoint is rate-limited (§27.5) and a
     request per keystroke spends that allowance in a second. */
  useEffect(() => {
    const query = term.trim();
    if (query.length < SEARCH_MINIMUM_TERM_LENGTH) {
      setFound([]);
      setSearched(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .directory(query)
        .then((result) => {
          if (cancelled) return;
          setFound(result.entries.filter((c) => c.principalId !== me));
          setSearched(true);
        })
        .catch(() => {
          if (!cancelled) setFound([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, me]);

  /* The field is the only thing to do on the two steps that have one. */
  useEffect(() => {
    if (step !== 'name') fieldRef.current?.focus();
  }, [step]);

  /*
     Escape backs OUT one step rather than closing outright.

     A panel is a place, and the way out of the third room is the second room. Closing
     from the name step would throw away a chosen membership somebody spent a minute on
     because they reached for the key that means "not this field".
  */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return;
      if (step === 'name') setStep('members');
      else if (step === 'members' && startAs !== 'group') setStep('chat');
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step, busy, onClose, startAs]);

  const create = async (people: readonly DirectoryEntry[], name?: string): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      /**
       * §21: one colleague is a DIRECT thread, more than one is a GROUP. Derived from the
       * COUNT rather than from the step — the step chose the form, and a group of one
       * would be a direct thread whatever the person pressed to get here.
       */
      if (people.length === 0) return;
      const created = await api.createConversation({
        type: people.length === 1 ? 'INTERNAL_DIRECT' : 'INTERNAL_GROUP',
        participantIds: people.map((person) => person.principalId),
        ...(name !== undefined && name.trim() !== '' ? { title: name.trim() } : {}),
      });
      /* BR-05: a repeated 1:1 returns the thread that already exists. Navigating to it is
         the right answer; reporting "already exists" would be telling somebody off for
         doing exactly what they meant. */
      onStarted(created.conversationId);
    } catch (cause) {
      setMessage(
        cause instanceof ApiError && cause.isRefusal
          ? 'That could not be started. Check the colleagues you chose.'
          : 'That did not go through. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const people = term.trim() === '' ? colleagues : found;
  const hues = distinctIdentityHues(people.map((entry) => entry.principalId));
  const heading = step === 'chat' ? 'New chat' : step === 'members' ? 'Add members' : 'New group';

  const back = (): void => {
    if (step === 'name') setStep('members');
    else if (step === 'members' && startAs !== 'group') setStep('chat');
    else onClose();
  };

  return (
    <div className="new-chat" ref={panelRef} role="region" aria-label={heading}>
      {/*
        A back arrow, not a cross.

        The panel is a place you went rather than a sheet dropped over you, and a place is
        left backwards. On the first step back IS close, which is the same gesture meaning
        the same thing one level up.
      */}
      <header className="new-chat-head">
        <button type="button" className="new-chat-back" onClick={back} disabled={busy} aria-label={step === 'chat' ? 'Close' : 'Back'}>
          <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false">
            <path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h2>{heading}</h2>
      </header>

      {step === 'name' ? (
        <NameStep
          title={title}
          onTitle={setTitle}
          chosen={chosen}
          busy={busy}
          message={message}
          onCreate={() => void create(chosen, title)}
        />
      ) : (
        <>
          <div className="new-chat-search">
            <label>
              <span className="sr-only">
                {step === 'chat' ? 'Who do you want to talk to?' : 'Who is in this group?'}
              </span>
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="m15.6 15.6 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                ref={fieldRef}
                type="search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Search name, department or @username"
                autoComplete="off"
              />
            </label>
          </div>

          {/* The one other thing you can start from here. It is a row rather than a tab,
              because it is a destination and not a mode of this screen. */}
          {step === 'chat' ? (
            <button type="button" className="new-chat-jump" onClick={() => setStep('members')}>
              <span className="new-chat-jump-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                  <circle cx="9" cy="9" r="3.2" />
                  <path d="M3.4 19c0-3 2.5-4.8 5.6-4.8 1.5 0 2.9.4 3.9 1.2" />
                  <path d="M16.4 7.6a3 3 0 0 1 0 5.6" />
                  <path d="M18 16.5v5M15.5 19h5" />
                </svg>
              </span>
              New group
            </button>
          ) : null}

          {/* The chosen sit ABOVE the list, as removable chips, the way every recipient
              field works. Below it they would read as an outcome of the search. */}
          {step === 'members' && chosen.length > 0 ? (
            <ul className="chosen" aria-label="Chosen colleagues">
              {chosen.map((person) => (
                <li key={person.principalId}>
                  <span className="chosen-avatar" aria-hidden="true">
                    {initialsFor(person.displayName)}
                    <AvatarImage principalId={person.principalId} alt="" />
                  </span>
                  <span>{person.displayName.split(' ')[0]}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${person.displayName}`}
                    onClick={() =>
                      setChosen((was) => was.filter((x) => x.principalId !== person.principalId))
                    }
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <ul className="people-list found" aria-live="polite">
            {people.map((entry) => {
              const picked = chosen.some((c) => c.principalId === entry.principalId);
              return (
                <li key={entry.principalId}>
                  <button
                    type="button"
                    className={`person-row${picked ? ' picked' : ''}`}
                    disabled={busy}
                    aria-pressed={step === 'members' ? picked : undefined}
                    onClick={() => {
                      if (step === 'chat') {
                        void create([entry]);
                        return;
                      }
                      /* A row TOGGLES. Pressing an added person again used to do nothing,
                         because the row left the results the moment it was chosen — so
                         undoing meant hunting for the chip. */
                      setChosen((was) =>
                        was.some((c) => c.principalId === entry.principalId)
                          ? was.filter((c) => c.principalId !== entry.principalId)
                          : [...was, entry],
                      );
                    }}
                  >
                    <span
                      className="row-avatar identity"
                      style={identityStyleFrom(hues, entry.principalId)}
                      aria-hidden="true"
                    >
                      {initialsFor(entry.displayName)}
                      <AvatarImage principalId={entry.principalId} alt="" />
                    </span>
                    <span className="person-text">
                      <span className="person-name">{entry.displayName}</span>
                      <span className="person-meta">
                        {entry.username !== undefined ? `@${entry.username}` : entry.department}
                        {/* INTEGRATION_CONTRACTS §1 rule 4: an interim identity source must
                            never be mistakable for a canonical one. */}
                        {entry.authority !== 'CANONICAL' ? (
                          <span className="provisional" title="Directory data is interim (HRMS pending)">
                            {' · interim'}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {step === 'members' ? (
                      <span className={`person-check${picked ? ' on' : ''}`} aria-hidden="true">
                        {picked ? (
                          <svg viewBox="0 0 24 24" width="13" height="13" focusable="false">
                            <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : null}
                      </span>
                    ) : null}
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
            /* Not "nobody in your team yet", which is a claim about the company and
               usually a false one. This list is a shortcut, not the directory. */
            <p className="muted result-note">
              Start typing to find anyone in the company — by name, or by @username.
            </p>
          ) : null}
          {searching && found.length === 0 ? <p className="muted result-note">Searching…</p> : null}
          {term.trim() !== '' && searched && !searching && found.length === 0 && message === undefined ? (
            <p className="muted result-note">No colleague matches that.</p>
          ) : null}
          {message !== undefined ? (
            <p role="alert" className="result-note result-note-error">
              {message}
            </p>
          ) : null}

          {/*
            The members step's foot: what is stopping you, and the way on.

            The line names the BLOCKING condition rather than reporting a count, which is
            the fix that came out of "not able to click on create group? why so?" — a
            disabled control beside "2 selected" says ready and no in the same breath.
          */}
          {step === 'members' ? (
            <div className="new-chat-foot">
              <span className={chosen.length >= 2 ? 'muted' : 'start-blocked'}>
                {chosen.length < 2 ? 'Choose at least two people' : `${chosen.length} selected`}
              </span>
              <button
                type="button"
                className="new-chat-next"
                onClick={() => setStep('name')}
                disabled={busy || chosen.length < 2}
                aria-label="Next: name this group"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                  <path d="M4.5 12h13m0 0-5.2-5.2M17.5 12l-5.2 5.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The last step: what the group is called.
 *
 * One field and one action, which is the point of it being its own step — there is nothing
 * here that can be half-done and no control that can sit dead while the person hunts for
 * the reason.
 */
function NameStep({
  title,
  onTitle,
  chosen,
  busy,
  message,
  onCreate,
}: {
  readonly title: string;
  readonly onTitle: (next: string) => void;
  readonly chosen: readonly DirectoryEntry[];
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly onCreate: () => void;
}): React.JSX.Element {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  return (
    <form
      className="new-chat-name"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && title.trim() !== '') onCreate();
      }}
    >
      {/*
        A picture cannot be set before the group exists.

        WhatsApp puts "Add group icon" here, and it can: its group is a local object until
        you confirm. Ours is created by the server, and the avatar endpoint takes a
        conversation id — so a control here would be collecting a file with nowhere to put
        it. The placeholder says what the group will look like and the info panel is where
        the picture is set, one press after this. Offering it here would be a picture of a
        feature.
      */}
      <span className="new-chat-avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">
          <circle cx="9" cy="9" r="3.4" />
          <path d="M2.8 19.4c0-3.2 2.8-5.2 6.2-5.2s6.2 2 6.2 5.2" />
          <path d="M16.6 7.3a3.2 3.2 0 0 1 0 6" />
          <path d="M18.2 19.4c0-2.4-.9-4-2.3-4.9" />
        </svg>
      </span>

      <label className="new-chat-name-field">
        <span className="sr-only">Group name</span>
        <input
          ref={nameRef}
          value={title}
          onChange={(event) => onTitle(event.target.value)}
          maxLength={200}
          placeholder="Group name"
          required
        />
      </label>

      <p className="new-chat-members">
        {chosen.length} {chosen.length === 1 ? 'person' : 'people'}:{' '}
        {chosen.map((person) => person.displayName.split(' ')[0]).join(', ')}
      </p>

      {message !== undefined ? (
        <p role="alert" className="result-note result-note-error">
          {message}
        </p>
      ) : null}

      <div className="new-chat-foot">
        <span className={title.trim() === '' ? 'start-blocked' : 'muted'}>
          {title.trim() === '' ? 'Name this group to create it' : 'Ready'}
        </span>
        <button
          type="submit"
          className="new-chat-next"
          disabled={busy || title.trim() === ''}
          aria-label="Create this group"
        >
          {busy ? (
            <span className="new-chat-working" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </form>
  );
}
