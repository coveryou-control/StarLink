'use client';

/**
 * Opening a channel, or changing what one lets people do.
 *
 * ## The three questions are three questions
 *
 * They are drawn as three separate groups because they ARE separate — a room can be
 * findable by everyone, readable by a department and writable by four people, and a single
 * "private / public" switch cannot say that. The reference sketch draws them the same way,
 * and it is right to.
 *
 * ## And they nest, so the form says so
 *
 * Reading requires seeing; posting requires reading. The option labels are phrased
 * relative to the answer above them — "Anyone who can see it", "Anyone who can read it" —
 * so the dependency is in the words rather than in a rule the author has to hold in their
 * head. There is no combination in this form that produces an incoherent policy, which is
 * the same property the enums have in the database.
 *
 * ## The sentence at the bottom
 *
 * A plain-language restatement of what the three answers add up to, updating as they
 * change. Somebody choosing an access policy for forty colleagues should be able to read
 * back what they have chosen without translating three dropdowns, and "Visible to everyone,
 * but only Technology members can read and post" is the sentence the reference puts on the
 * screen for exactly that reason.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type ChannelAudienceEntry, type ChannelSummary } from '../lib/api-client';

type Purpose = ChannelSummary['purpose'];
type Visibility = ChannelSummary['visibility'];
type ReadAccess = ChannelSummary['readAccess'];
type PostAccess = ChannelSummary['postAccess'];

interface Scopes {
  readonly departments: readonly string[];
  readonly teams: readonly { readonly teamId: string; readonly displayName: string }[];
}

/**
 * A labelled group of exclusive choices.
 *
 * A radio group rather than a `<select>`: there are two or three options, each needs a line
 * of explanation, and the whole point of this form is that the options are visible at once
 * rather than hidden behind a control you have to open to learn what the alternatives are.
 */
function ChoiceGroup<T extends string>({
  legend,
  value,
  options,
  onChange,
  name,
}: {
  readonly legend: string;
  readonly value: T;
  readonly options: readonly { readonly id: T; readonly label: string; readonly hint?: string }[];
  readonly onChange: (value: T) => void;
  readonly name: string;
}): ReactNode {
  return (
    <fieldset className="channel-choices">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.id} className={`channel-choice${value === option.id ? ' chosen' : ''}`}>
          <input
            type="radio"
            name={name}
            checked={value === option.id}
            onChange={() => onChange(option.id)}
          />
          <span>
            <span className="channel-choice-label">{option.label}</span>
            {option.hint !== undefined ? (
              <span className="channel-choice-hint">{option.hint}</span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function ChannelDialog({
  editing,
  onDismiss,
  onSaved,
}: {
  /** Absent when opening a new channel; the existing policy when editing one. */
  readonly editing?:
    | {
        readonly channel: ChannelSummary;
        readonly audience: readonly ChannelAudienceEntry[];
      }
    | undefined;
  readonly onDismiss: () => void;
  readonly onSaved: (conversationId: string) => void;
}): ReactNode {
  const existing = editing?.channel;
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [purpose, setPurpose] = useState<Purpose>(existing?.purpose ?? 'DEPARTMENT');
  const [visibility, setVisibility] = useState<Visibility>(existing?.visibility ?? 'EVERYONE');
  const [readAccess, setReadAccess] = useState<ReadAccess>(existing?.readAccess ?? 'MEMBERS');
  const [postAccess, setPostAccess] = useState<PostAccess>(existing?.postAccess ?? 'MEMBERS');
  const [audience, setAudience] = useState<readonly ChannelAudienceEntry[]>(
    editing?.audience ?? [],
  );
  const [scopes, setScopes] = useState<Scopes | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    void api
      .channelScopes()
      .then(setScopes)
      /* An unreadable scope list is not an empty one. The audience section says so rather
         than rendering as "there are no departments", which would be a lie that leads
         somebody to widen a channel they meant to narrow. */
      .catch(() => setScopes(undefined));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const toggleScope = (entry: ChannelAudienceEntry): void => {
    setAudience((current) =>
      current.some((a) => a.scopeKind === entry.scopeKind && a.scopeId === entry.scopeId)
        ? current.filter((a) => !(a.scopeKind === entry.scopeKind && a.scopeId === entry.scopeId))
        : [...current, entry],
    );
  };

  const chosen = (entry: ChannelAudienceEntry): boolean =>
    audience.some((a) => a.scopeKind === entry.scopeKind && a.scopeId === entry.scopeId);

  /** The plain-language restatement. Derived, never stored. */
  const sentence = useMemo(() => {
    const who =
      visibility === 'EVERYONE' ? 'Everyone in the company can see this channel'
      : visibility === 'DEPARTMENTS'
        ? audience.length === 0
          ? 'Nobody can see it yet — choose at least one department or team'
          : `Only ${audience.length} selected ${audience.length === 1 ? 'group' : 'groups'} can see it`
        : audience.length === 0
          ? 'Nobody can see it yet — choose at least one person'
          : `Only ${audience.length} selected ${audience.length === 1 ? 'person' : 'people'} can see it`;
    const read = readAccess === 'ANYONE_WHO_CAN_SEE' ? 'read it' : 'members can read it';
    const post =
      postAccess === 'ANYONE_WHO_CAN_READ' ? 'and post in it'
      : postAccess === 'MEMBERS' ? 'and members can post'
      : 'and only admins can post';
    return `${who}, ${readAccess === 'ANYONE_WHO_CAN_SEE' ? `they can ${read}` : read}, ${post}.`;
  }, [visibility, readAccess, postAccess, audience.length]);

  /** Refused before the request, for the same reason the server refuses it. */
  const audienceMissing = visibility !== 'EVERYONE' && audience.length === 0;
  const canSave = name.trim() !== '' && !audienceMissing && !busy;

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    setProblem(undefined);
    const input = {
      name: name.trim(),
      ...(description.trim() !== '' ? { description: description.trim() } : {}),
      purpose,
      visibility,
      readAccess,
      postAccess,
      /* Cleared when the visibility does not use one, so switching to "Everyone" does not
         leave a stale department list in the database for the next edit to resurrect. */
      audience: visibility === 'EVERYONE' ? [] : audience,
    };
    try {
      if (existing !== undefined) {
        await api.updateChannel(existing.conversationId, input);
        onSaved(existing.conversationId);
      } else {
        const created = await api.createChannel(input);
        onSaved(created.conversationId);
      }
    } catch (cause) {
      /*
         The one failure worth naming. A duplicate name arrives as the same refusal as every
         other, and "that did not work" for a channel called Technology when Technology
         already exists is a puzzle the second attempt reproduces exactly.
      */
      setProblem(
        cause instanceof ApiError && cause.status === 404
          ? existing !== undefined
            ? 'That change was refused. You may no longer administer this channel, or the name is already taken.'
            : 'That channel could not be created. The name may already be taken, or you may no longer create channels.'
          : 'That channel could not be saved. Nothing has changed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <section
        className="channel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="channel-dialog-head">
          <h2 id="channel-dialog-title">{existing !== undefined ? 'Edit channel' : 'New channel'}</h2>
          <button type="button" className="channel-dialog-close" onClick={onDismiss} aria-label="Close">
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

        <div className="channel-dialog-body">
          <label className="channel-field">
            <span>Channel name</span>
            <input
              ref={nameRef}
              type="text"
              value={name}
              maxLength={120}
              placeholder="Technology"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label className="channel-field">
            <span>Description</span>
            <textarea
              value={description}
              maxLength={400}
              rows={2}
              placeholder="What this channel is for."
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <ChoiceGroup
            name="channel-purpose"
            legend="What is it for?"
            value={purpose}
            onChange={setPurpose}
            options={[
              { id: 'DEPARTMENT', label: 'A department' },
              { id: 'TEAM', label: 'A team' },
              { id: 'PROJECT', label: 'A project' },
              { id: 'OTHER', label: 'Something else' },
            ]}
          />

          <ChoiceGroup
            name="channel-visibility"
            legend="Who can see this channel?"
            value={visibility}
            onChange={setVisibility}
            options={[
              {
                id: 'EVERYONE',
                label: 'Everyone in the company',
                hint: 'It appears in everyone’s channel directory.',
              },
              {
                id: 'DEPARTMENTS',
                label: 'Specific departments or teams',
              },
              {
                id: 'SELECTED',
                label: 'Selected people only',
                hint: 'Nobody else is told it exists.',
              },
            ]}
          />

          {visibility === 'DEPARTMENTS' ? (
            <div className="channel-audience">
              {scopes === undefined ? (
                <p className="channel-choice-hint">
                  The list of departments and teams could not be loaded. This is not the same
                  as there being none — try again before choosing.
                </p>
              ) : (
                <>
                  <p className="channel-audience-label">Departments</p>
                  <div className="channel-chips">
                    {scopes.departments.map((department) => (
                      <button
                        key={`d-${department}`}
                        type="button"
                        className={`channel-chip${
                          chosen({ scopeKind: 'DEPARTMENT', scopeId: department }) ? ' chosen' : ''
                        }`}
                        aria-pressed={chosen({ scopeKind: 'DEPARTMENT', scopeId: department })}
                        onClick={() => toggleScope({ scopeKind: 'DEPARTMENT', scopeId: department })}
                      >
                        {department}
                      </button>
                    ))}
                  </div>
                  <p className="channel-audience-label">Teams</p>
                  <div className="channel-chips">
                    {scopes.teams.map((team) => (
                      <button
                        key={`t-${team.teamId}`}
                        type="button"
                        className={`channel-chip${
                          chosen({ scopeKind: 'TEAM', scopeId: team.teamId }) ? ' chosen' : ''
                        }`}
                        aria-pressed={chosen({ scopeKind: 'TEAM', scopeId: team.teamId })}
                        onClick={() => toggleScope({ scopeKind: 'TEAM', scopeId: team.teamId })}
                      >
                        {team.displayName}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}

          {visibility === 'SELECTED' ? (
            <div className="channel-audience">
              <p className="channel-choice-hint">
                {/*
                  Named people are added as MEMBERS after the channel exists, through the
                  same membership panel every other conversation uses — rather than a second
                  people-picker here that would write a different kind of row.

                  Being a member already makes the channel visible to somebody, whatever the
                  audience table says, so this is not a gap: it is the one route to
                  membership rather than two.
                */}
                Add people from the channel’s members panel once it exists. Anybody you add is
                a member, and a member can always see the channel they are in.
              </p>
            </div>
          ) : null}

          <ChoiceGroup
            name="channel-read"
            legend="Who can read messages?"
            value={readAccess}
            onChange={setReadAccess}
            options={[
              {
                id: 'ANYONE_WHO_CAN_SEE',
                label: 'Anyone who can see it',
                hint: 'An open channel — no need to join before reading.',
              },
              {
                id: 'MEMBERS',
                label: 'Members only',
                hint: 'People can find the channel and are told they are not in it.',
              },
            ]}
          />

          <ChoiceGroup
            name="channel-post"
            legend="Who can post?"
            value={postAccess}
            onChange={setPostAccess}
            options={[
              { id: 'ANYONE_WHO_CAN_READ', label: 'Anyone who can read it' },
              { id: 'MEMBERS', label: 'Members only' },
              {
                id: 'ADMINS',
                label: 'Channel admins only',
                hint: 'A notice board. Everyone who can read it may still react.',
              },
            ]}
          />

          <p className={`channel-summary${audienceMissing ? ' warn' : ''}`} role="status">
            {sentence}
          </p>

          {problem !== undefined ? (
            <p className="state-note" role="alert">
              {problem}
            </p>
          ) : null}
        </div>

        <footer className="channel-dialog-foot">
          <button type="button" onClick={onDismiss}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? 'Saving…' : existing !== undefined ? 'Save changes' : 'Create channel'}
          </button>
        </footer>
      </section>
    </div>
  );
}
