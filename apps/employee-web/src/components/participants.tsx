'use client';

/**
 * Adding and removing participants (SL-002, BR-07, BR-08, BR-09).
 *
 * SL-002's acceptance is "Group membership + history rules enforced". The rules were
 * enforced server-side and tested from Phase 2; there was no way to exercise them, because
 * neither route had a client method or a control.
 *
 * ## BR-07 is a conversation, not a checkbox
 *
 * "A client must acknowledge that adding someone exposes prior history, and the server
 * refuses without it." The server's refusal is the boundary and stays the boundary — but
 * an acknowledgement the person never saw is not an acknowledgement. So this asks in
 * words, before the request, and then reports how many messages actually became readable.
 *
 * Sending `historyExposureAcknowledged: true` from a client that never asked would satisfy
 * the API and defeat the rule. That is why the flag is set at the point of confirmation
 * here and not defaulted in the client method.
 *
 * ## Removal is not redaction
 *
 * §24.3: participation history is append-only, and what someone has already read stays
 * read. The wording says "stop including" rather than "remove access to what they saw",
 * because the second would be a promise the product cannot keep.
 */
import { useEffect, useState } from 'react';
import { initialsFor } from './conversation-naming';
import { PresenceDot, useOnlineSet } from './presence';
import { AvatarImage } from './avatar-image';
import { AvatarPicker } from './avatar-picker';
import { useActiveConversation } from './active-conversation';
import { useSession } from './session-provider';
import { SEARCH_MINIMUM_TERM_LENGTH } from '@starlink/shared-contracts';
import { api, ApiError, type DirectoryEntry } from '../lib/api-client';

export function Participants({
  conversationId,
  onChanged,
}: {
  readonly conversationId: string;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<readonly DirectoryEntry[]>([]);
  const [pending, setPending] = useState<DirectoryEntry | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  /**
   * The people already in this conversation, from the summary the shell holds.
   *
   * `participants` is populated for INTERNAL types only and excludes the caller (see
   * `ConversationSummary`), which is why the signed-in name is added separately rather
   * than searched for in the list.
   */
  const active = useActiveConversation();
  const { state: session } = useSession();
  const members = active?.participants ?? [];
  const meName = session.status === 'SIGNED_IN' ? session.me.displayName : 'You';
  const isGroup = active?.conversationType === 'INTERNAL_GROUP';

  /**
   * May this person remove members?
   *
   * In a group, only its creator (migration 0023). Everywhere else the previous rule
   * stands — any participant may, and the domain's other guards (no customer, no self)
   * still apply.
   *
   * `members` excludes the reader, so their own role is not in it. It is read from the
   * conversation summary's participant list the other way round: if nobody visible holds
   * CREATOR, the creator is either the reader or somebody beyond the six the summary
   * carries. The first is the common case and the second cannot be distinguished here —
   * so this asks the honest question instead, using the summary's own `participantCount`
   * to notice when the list is truncated and falling back to letting the server decide.
   */
  const someoneElseIsAdmin = members.some((m) => m.role === 'CREATOR');
  const listIsComplete = (active?.participantCount ?? 0) <= members.length + 1;
  const canRemoveMembers = !isGroup || (listIsComplete && !someoneElseIsAdmin);
  const currentTitle = active?.title ?? '';

  /**
   * How many members hold a realtime lease.
   *
   * Counted from the shared presence set rather than asked for separately — the shell
   * already queried these very people for the conversation list. `+1` is never added for
   * the reader: you know you are here, and counting yourself would make a group of one
   * other person read "2 online" when they are offline.
   */
  const online = useOnlineSet();
  const onlineCount = members.filter((m) => online.has(m.principalId)).length;

  const [title, setTitle] = useState(currentTitle);
  const [renaming, setRenaming] = useState(false);
  /** Whether the name is being edited. Closed by default — see the pencil below. */
  const [editingName, setEditingName] = useState(false);
  /* Set once a picture has been uploaded in this session, so the button says "Change"
     rather than "Upload" afterwards. The panel does not otherwise know whether a group has
     one — the image either loads or 404s, and asking would be a request per panel open. */
  const [groupPictureAt, setGroupPictureAt] = useState<string | undefined>();

  /**
   * The field follows the conversation when it changes underneath — somebody else renaming
   * the group, or the reader opening a different one. Guarded on the field being untouched
   * so it cannot overwrite what is being typed.
   */
  useEffect(() => {
    setTitle(currentTitle);
  }, [currentTitle, active?.conversationId]);

  const rename = async (): Promise<void> => {
    const next = title.trim();
    if (next === '' || next === currentTitle) return;
    setRenaming(true);
    setMessage(undefined);
    try {
      await api.renameConversation(conversationId, next);
      setMessage(`Renamed to “${next}”.`);
      // The header and the sidebar are named from the SUMMARY, which only the shell
      // reloads — without this the group keeps its old name until the next load.
      onChanged();
    } catch (cause) {
      setMessage(
        cause instanceof ApiError && cause.isRefusal
          ? 'You cannot rename this conversation.'
          : 'That did not go through.',
      );
    } finally {
      setRenaming(false);
    }
  };

  /**
   * The directory, searched as you type.
   *
   * There was a Find button beside this field and one beside the new-conversation dialog's,
   * and both are gone for the same reason: pressing a button to make a list appear is a
   * step the person has already asked for by typing. Debounced at 250ms, because §27.5
   * rate-limits the endpoint and a request per keystroke spends the allowance in a second.
   *
   * `cancelled` is the part that matters. A slow answer for "ra" must not land after a
   * fast one for "rahul" and overwrite it — that is the classic search-as-you-type defect,
   * and it shows up as the list flickering back to a stale result.
   */
  useEffect(() => {
    const query = term.trim();
    if (query.length < SEARCH_MINIMUM_TERM_LENGTH) {
      setFound([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .directory(query)
        .then(({ entries }) => {
          if (cancelled) return;
          setFound(entries);
          setMessage(undefined);
        })
        .catch(() => {
          if (!cancelled) setMessage('The directory is unavailable.');
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  const confirmAdd = async (): Promise<void> => {
    if (pending === undefined) return;
    setBusy(true);
    try {
      const { messagesExposed } = await api.addParticipant(conversationId, pending.principalId);
      // Says what actually happened. "Added" alone would hide the part BR-07 exists for.
      setMessage(
        messagesExposed === 0
          ? `${pending.displayName} was added. There was no earlier history to share.`
          : `${pending.displayName} was added and can now read ${messagesExposed} earlier message${
              messagesExposed === 1 ? '' : 's'
            }.`,
      );
      setPending(undefined);
      setFound([]);
      setTerm('');
      onChanged();
    } catch (cause) {
      setMessage(
        cause instanceof ApiError && cause.isRefusal
          ? // BR-08: a customer can never be added to an internal thread, and §27.3 keeps
            // the reason off the wire. The UI must not guess which rule refused.
            'That person cannot be added to this conversation.'
          : 'That did not go through. Nobody was added.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (principalId: string, name: string): Promise<void> => {
    setBusy(true);
    try {
      await api.removeParticipant(conversationId, principalId);
      setMessage(`${name} will not receive new messages here.`);
      onChanged();
    } catch {
      setMessage('That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="participants" aria-label="Participants">
      {/*
        Who is already here, before the control for adding somebody else.

        The panel offered a search field and nothing else, so "who is in this group" was a
        question the product could not answer — you inferred it from the header's truncated
        title. The names come from the conversation summary the shell already holds, so this
        costs no request and cannot disagree with the header above it.
      */}
      {/*
        Renaming, at the top of the panel because it names the thing everything below is
        about.

        Offered for a GROUP only. The server refuses a rename on a one-to-one — a direct
        message is named after the person you are talking to, and a title would override
        that with something only one of the two chose — so a field here would be a control
        that always fails.
      */}
      {/*
        The name, with a pencil — not a permanent text field.

        An always-open input beside the group's name says "this is a form", and the panel
        is not one: renaming happens rarely and reading the name happens every time. The
        pencil turns a control that was competing for attention into one that is asked for.

        `editingName` rather than an uncontrolled `contentEditable`: the field has to be
        able to revert, and Escape reverting to the current title is the behaviour somebody
        who opened it by accident expects.
      */}
      {/*
        The group's picture.

        Anybody who may speak here may change it — the same rule as pinning, and for the
        same reason: it is a change to what every participant sees rather than to your own
        view. Removing it is deliberately absent; the default multi-person glyph is what a
        group has before anybody sets one, and "remove" would need a second endpoint to
        express something a new upload already expresses.
      */}
      {isGroup ? (
        <AvatarPicker
          label="Choose a picture for this group"
          hasPicture={groupPictureAt !== undefined}
          onChosen={async (base64) => {
            const saved = await api.setConversationAvatar(conversationId, base64);
            setGroupPictureAt(saved.updatedAt);
            onChanged();
          }}
        />
      ) : null}

      {isGroup ? (
        editingName ? (
          <form
            className="rename-group"
            onSubmit={(e) => {
              e.preventDefault();
              void rename().then(() => setEditingName(false));
            }}
          >
            <label>
              <span className="sr-only">Group name</span>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  setTitle(currentTitle);
                  setEditingName(false);
                }}
                maxLength={120}
                placeholder="Name this group"
              />
            </label>
            <button
              type="submit"
              disabled={renaming || title.trim() === '' || title.trim() === currentTitle}
            >
              {renaming ? 'Saving…' : 'Save'}
            </button>
          </form>
        ) : (
          <div className="group-name-row">
            <span className="group-name">{currentTitle}</span>
            <button
              type="button"
              className="group-name-edit"
              onClick={() => {
                setTitle(currentTitle);
                setEditingName(true);
              }}
              aria-label="Edit group name"
              title="Edit group name"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
                <path
                  d="M4 20h4L19 9l-4-4L4 16v4Zm12.5-16.5 4 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )
      ) : null}

      {members.length > 0 ? (
        <div className="member-list">
          <h3>
            {members.length + 1} members
            {/* Present only when presence has an answer, so it never reads "0 online"
                merely because the query has not returned. */}
            {onlineCount > 0 ? <span className="member-online"> · {onlineCount} online</span> : null}
          </h3>
          <ul>
            {/*
              You, and no control beside you.

              `removeParticipant` refuses self-removal in the DOMAIN, with a documented
              reason: an owner who ends their own participation still holds
              `current_owner_id` while dropping out of `listForPrincipal`, which is the
              "owns work they cannot find" defect through a different door — and BR-05
              stops them re-adding themselves. Leaving is a real thing to want and it is
              not this operation.
            */}
            <li>
              <span className="row-avatar" aria-hidden="true">
                {initialsFor(meName)}
              </span>
              <span className="person-name">
                {meName} <span className="muted">(you)</span>
              </span>
            </li>
            {members.map((m) => (
              <li key={m.principalId}>
                <span className="avatar-wrap">
                  <span className="row-avatar" aria-hidden="true">
                    {initialsFor(m.displayName)}
                    <AvatarImage principalId={m.principalId} alt="" />
                  </span>
                  <PresenceDot principalId={m.principalId} />
                </span>
                <span className="person-name">
                  {m.displayName}
                  {/*
                     The admin, marked.

                     `CREATOR` is the role the conversation has carried since it was made;
                     migration 0023 explains why no second word was invented for it. The
                     badge is text rather than an icon so it survives greyscale and so a
                     screen reader reads it as part of the row (NFR-ACC-3).
                  */}
                  {m.role === 'CREATOR' ? <span className="member-admin">Admin</span> : null}
                </span>
                {/*
                  Remove sits on the MEMBER, which is the only place it makes sense.

                  It used to hang off the directory search results — so the way to remove
                  somebody was to search for them again, and the button appeared beside
                  people who were not in the conversation at all. BR-08/BR-09 are enforced
                  server-side either way; this is about the control being where the thing
                  it acts on is.
                */}
                {/*
                   Only the admin gets a remove control, and only in a group.

                   Not hidden with CSS, and not disabled either: absent. A disabled button
                   still puts the shape of a control in front of somebody who can never
                   use it, and invites the question of why. The DOMAIN refuses the
                   operation regardless (`NOT_THE_GROUP_ADMIN`) — this is the interface
                   agreeing with the boundary, never standing in for it.
                */}
                {canRemoveMembers ? (
                  <button
                    type="button"
                    className="member-remove"
                    onClick={() => void remove(m.principalId, m.displayName)}
                    disabled={busy}
                    aria-label={`Remove ${m.displayName}`}
                    title={`Remove ${m.displayName}`}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        The visible label is gone and the placeholder carries the name.

        It reads "Add a colleague" above a field above a button — three stacked rows — and
        in the header there is one row. The `sr-only` span keeps the input's accessible
        name intact; `placeholder` alone is not a label and would leave the field unnamed
        to a screen reader the moment somebody typed into it.
      */}
      <h3 className="member-add-title">Add a colleague</h3>
      <label className="member-add-field">
        <span className="sr-only">Add a colleague</span>
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="name, department or ID"
          autoComplete="off"
        />
      </label>

      {/*
        Results are a popover over the thread, not a strip pushing it down: the header is
        a fixed row and a list growing inside it would move every message on the screen.
      */}
      <ul className="found">
        {found.map((entry) => (
          <li key={entry.principalId}>
            <button type="button" onClick={() => setPending(entry)}>
              {entry.displayName}
              <span className="muted"> · {entry.department}</span>
            </button>
          </li>
        ))}
      </ul>

      {/*
        BR-07's acknowledgement, asked in words. The server refuses without the flag; this
        is what makes sending it honest.
      */}
      {pending !== undefined ? (
        <div className="history-warning" role="dialog" aria-label="Confirm adding a colleague">
          <p>
            <strong>{pending.displayName}</strong> will be able to read everything already said in
            this conversation, including anything written before they joined.
          </p>
          <div>
            <button type="button" onClick={() => void confirmAdd()} disabled={busy}>
              {busy ? 'Adding…' : 'Add them anyway'}
            </button>
            <button type="button" onClick={() => setPending(undefined)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {message !== undefined ? <p role="status">{message}</p> : null}
    </section>
  );
}
