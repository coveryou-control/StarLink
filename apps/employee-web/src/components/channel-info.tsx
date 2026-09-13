'use client';

/**
 * What a channel is, and who it is for, in the details panel.
 *
 * ## Why the access policy is shown to everybody
 *
 * A person about to write in a room deserves to know who will be able to read it. "Visible
 * to everyone in the company, readable by members" is the difference between a note to four
 * colleagues and a note to four hundred, and a product that keeps that to itself is asking
 * people to guess.
 *
 * The AUDIENCE — which departments, which named people — is the one part held back, and only
 * to those who may edit it. It enumerates the company's team names to anybody with an
 * account, and the summary above already answers the question a writer is actually asking.
 * The server decides that, not this component: `audience` simply is not in the response for
 * somebody who may not manage the channel.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type ChannelAudienceEntry, type ChannelSummary } from '../lib/api-client';
import { ChannelDialog } from './channel-dialog';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const;

function EyeGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" {...stroke} />
      <circle cx="12" cy="12" r="2.6" {...stroke} />
    </svg>
  );
}

function BookGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M4 5.5h6a2 2 0 0 1 2 2v11a2 2 0 0 0-2-2H4Z" {...stroke} strokeLinejoin="round" />
      <path d="M20 5.5h-6a2 2 0 0 0-2 2v11a2 2 0 0 1 2-2h6Z" {...stroke} strokeLinejoin="round" />
    </svg>
  );
}

function PenGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z" {...stroke} strokeLinejoin="round" />
      <path d="M15 6.5 17.5 9" {...stroke} strokeLinecap="round" />
    </svg>
  );
}

const VISIBILITY_TEXT: Readonly<Record<ChannelSummary['visibility'], string>> = {
  EVERYONE: 'Everyone in the company',
  DEPARTMENTS: 'Selected departments and teams',
  SELECTED: 'Selected people only',
};

const READ_TEXT: Readonly<Record<ChannelSummary['readAccess'], string>> = {
  ANYONE_WHO_CAN_SEE: 'Anyone who can see this channel',
  MEMBERS: 'Channel members only',
};

const POST_TEXT: Readonly<Record<ChannelSummary['postAccess'], string>> = {
  ANYONE_WHO_CAN_READ: 'Anyone who can read this channel',
  MEMBERS: 'Channel members only',
  ADMINS: 'Channel admins only',
};

export function ChannelInfo({
  channel,
  audience,
  onChanged,
}: {
  readonly channel: ChannelSummary;
  /** Present only when the server judged this person may manage the channel. */
  readonly audience: readonly ChannelAudienceEntry[] | undefined;
  readonly onChanged: () => void;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  const setArchived = async (archived: boolean): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      await api.setChannelArchived(channel.conversationId, archived);
      onChanged();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError && cause.status === 404
          ? 'You are no longer able to administer this channel. Nothing has changed.'
          : 'That could not be changed. Nothing has changed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="details-section" aria-label="Channel access">
      {channel.description !== undefined ? (
        <p className="details-note">{channel.description}</p>
      ) : null}

      <div className="channel-access">
        <div className="channel-access-row">
          <EyeGlyph />
          <span>
            <span className="channel-access-term">Visible to</span>
            <span className="channel-access-value">{VISIBILITY_TEXT[channel.visibility]}</span>
          </span>
        </div>
        <div className="channel-access-row">
          <BookGlyph />
          <span>
            <span className="channel-access-term">Readable by</span>
            <span className="channel-access-value">{READ_TEXT[channel.readAccess]}</span>
          </span>
        </div>
        <div className="channel-access-row">
          <PenGlyph />
          <span>
            <span className="channel-access-term">Posting</span>
            <span className="channel-access-value">{POST_TEXT[channel.postAccess]}</span>
          </span>
        </div>
      </div>

      {/*
        The audience itself, for whoever may change it.

        Not withheld as a secret — an administrator editing the policy has to be able to see
        what it currently is, and the dialog would otherwise open with chips they cannot
        verify against anything.
      */}
      {audience !== undefined && audience.length > 0 ? (
        <div className="channel-chips" style={{ marginTop: 'var(--space-2)' }}>
          {audience.map((entry) => (
            <span key={`${entry.scopeKind}-${entry.scopeId}`} className="channel-chip">
              {entry.scopeId}
            </span>
          ))}
        </div>
      ) : null}

      {channel.archived ? (
        <p className="details-note">
          This channel is archived. Its history stays here and nothing new can be posted.
        </p>
      ) : null}

      {problem !== undefined ? (
        <p className="state-note" role="alert">
          {problem}
        </p>
      ) : null}

      {/*
        Administration, only for those who hold it — and the server said so, this component
        did not work it out from the policy. Every one of these re-decides on the server.
      */}
      {channel.mayManage ? (
        <div className="details-actions">
          <button type="button" onClick={() => setEditing(true)}>
            Edit channel
          </button>
          <button type="button" disabled={busy} onClick={() => void setArchived(!channel.archived)}>
            {channel.archived ? 'Restore channel' : 'Archive channel'}
          </button>
        </div>
      ) : null}

      {editing ? (
        <ChannelDialog
          editing={{ channel, audience: audience ?? [] }}
          onDismiss={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
