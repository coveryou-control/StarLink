'use client';

/**
 * A group's picture and its name, edited where they are shown.
 *
 * ## What this replaces
 *
 * Both controls lived in `Participants`, three sections below the avatar and the title
 * they change: a labelled "Upload a picture" button, a "Remove" beside it, a paragraph
 * about 256px squares, and further down a name row with its own pencil. Four rows of
 * chrome in a panel whose first two elements are the very picture and the very name being
 * edited.
 *
 * A control belongs beside the thing it edits. The camera is on the corner of the circle,
 * where every product puts it and where it needs no label; the pencil is at the end of the
 * name. Nothing was removed — the explanation about how a picture is stored is on the
 * camera's accessible name, findable by anybody who wants it and read by nobody who does
 * not.
 *
 * ## Why it is its own component rather than inlined
 *
 * The rename has real behaviour behind it: a refusal that has to be reported honestly, a
 * field that must follow the conversation when somebody else renames it, and Escape
 * reverting rather than saving. Putting that in the panel's JSX would put four pieces of
 * state into a file that already holds the whole conversation screen — and leaving it in
 * `Participants` while the CONTROL moved would be a component reaching across the panel
 * to render into another one.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError } from '../lib/api-client';
import { AvatarPicker } from './avatar-picker';

export function GroupIdentity({
  conversationId,
  title,
  children,
  onChanged,
}: {
  readonly conversationId: string;
  /** The name as the shell knows it — the summary is the source of truth. */
  readonly title: string;
  /** The avatar itself, drawn by the panel; this only adds the camera to its corner. */
  readonly children: ReactNode;
  readonly onChanged: () => void;
}): ReactNode {
  const [draft, setDraft] = useState(title);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  /*
     Set once a picture has been uploaded in this session, so the control says "Change"
     rather than "Add" afterwards. The panel does not otherwise know whether a group has
     one — the image either loads or 404s, and asking would be a request per panel open.
  */
  const [pictureAt, setPictureAt] = useState<string | undefined>();

  /* The field follows the conversation when it changes underneath — somebody else
     renaming the group, or the reader opening a different one. */
  useEffect(() => {
    setDraft(title);
    setEditing(false);
  }, [title, conversationId]);

  const rename = async (): Promise<void> => {
    const next = draft.trim();
    if (next === '' || next === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setProblem(undefined);
    try {
      await api.renameConversation(conversationId, next);
      setEditing(false);
      /* The header and the sidebar are named from the SUMMARY, which only the shell
         reloads — without this the group keeps its old name until the next load. */
      onChanged();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError && cause.isRefusal
          ? 'You cannot rename this conversation.'
          : 'That did not go through.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <span className="details-avatar-slot">
        {children}
        <AvatarPicker
          variant="corner"
          label="Choose a picture for this group"
          hasPicture={pictureAt !== undefined}
          onChosen={async (base64) => {
            const saved = await api.setConversationAvatar(conversationId, base64);
            setPictureAt(saved.updatedAt);
            onChanged();
          }}
        />
      </span>

      {editing ? (
        <form
          className="details-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <label>
            <span className="sr-only">Group name</span>
            <input
              autoFocus
              value={draft}
              maxLength={120}
              placeholder="Name this group"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                /* Escape reverts rather than saving. Somebody who opened the field by
                   accident must be able to leave without renaming the group. */
                if (event.key !== 'Escape') return;
                setDraft(title);
                setEditing(false);
              }}
            />
          </label>
          <button type="submit" disabled={saving || draft.trim() === ''}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      ) : (
        <span className="details-identity-name">
          {title}
          <button
            type="button"
            className="details-name-edit"
            onClick={() => {
              setDraft(title);
              setEditing(true);
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
        </span>
      )}

      {problem !== undefined ? (
        <p className="details-empty" role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}
