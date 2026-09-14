'use client';

/**
 * What the information panel shows when the reader is only inspecting.
 *
 * ## Why it replaces the ordinary panel rather than trimming it
 *
 * The ordinary panel is a MEMBERSHIP panel: it counts "you and four others", offers to add a
 * colleague, offers to remove one, and offers to leave. Every line of that is wrong for a
 * reader who is not in the conversation — the count would include them, and the three
 * controls are writes the server would refuse anyway.
 *
 * What replaces it is not a reduced version of it. An auditor asks a different question: not
 * "who is here" but "what is this thread, who was in it, when, from which part of the
 * company, and what was attached" — which is what the participation rows actually hold and
 * what a member list has never been able to show.
 *
 * ## Everything here is the audit API's own read
 *
 * `auditApi.participants` and `auditApi.messages` are decided server-side per call and
 * written to the ledger before any content is read (see `audit-access.ts`). Nothing is
 * derived from the employee endpoints, and nothing here can write.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import {
  auditApi,
  type AuditAttachment,
  type AuditMessage,
  type AuditParticipant,
} from '../lib/api-client';
import { auditWhen, describeAuditFailure } from '../lib/audit-errors';

/** A failure, said plainly, with a way to try again. */
export function AuditProblem({
  error,
  onRetry,
}: {
  readonly error: string;
  readonly onRetry?: (() => void) | undefined;
}): ReactNode {
  return (
    <p className="oversight-problem" role="alert">
      {error}
      {onRetry !== undefined ? (
        <button type="button" className="oversight-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </p>
  );
}

const TYPE_LABEL: Readonly<Record<string, string>> = {
  INTERNAL_DIRECT: 'Direct chat',
  INTERNAL_GROUP: 'Group',
  INTERNAL_CHANNEL: 'Channel',
  INTERNAL_ANNOUNCEMENT: 'Announcement',
  CUSTOMER_SERVICE: 'Customer — service',
  CUSTOMER_SALES: 'Customer — sales',
  CUSTOMER_RENEWAL: 'Customer — renewal',
  CUSTOMER_CLAIM: 'Customer — claim',
  CUSTOMER_GRIEVANCE: 'Customer — grievance',
  CUSTOMER_GENERAL: 'Customer',
};

export function OversightDetails({
  conversationId,
  title,
  conversationType,
  participantCount,
  lastActivityAt,
}: {
  readonly conversationId: string;
  readonly title?: string | undefined;
  readonly conversationType?: string | undefined;
  readonly participantCount?: number | undefined;
  readonly lastActivityAt?: string | undefined;
}): ReactNode {
  return (
    <>
      <About
        {...(title !== undefined ? { title } : {})}
        {...(conversationType !== undefined ? { conversationType } : {})}
        {...(participantCount !== undefined ? { participantCount } : {})}
        {...(lastActivityAt !== undefined ? { lastActivityAt } : {})}
      />
      <Roster conversationId={conversationId} />
      <Files conversationId={conversationId} />
    </>
  );
}

/**
 * What this thread IS — the half of the question that is not "who".
 *
 * Every fact comes from the list row the panel was opened from, so nothing here is a second
 * read and nothing here can be more current than the list. The access scope is stated
 * because it is the honest answer to "why can I see this": not membership, a capability.
 */
function About({
  title,
  conversationType,
  participantCount,
  lastActivityAt,
}: {
  readonly title?: string;
  readonly conversationType?: string;
  readonly participantCount?: number;
  readonly lastActivityAt?: string;
}): ReactNode {
  return (
    <section className="details-section">
      <h3 className="details-section-title">About</h3>
      <dl className="oversight-facts">
        {title !== undefined ? (
          <>
            <dt>Name</dt>
            <dd>{title}</dd>
          </>
        ) : null}
        {conversationType !== undefined ? (
          <>
            <dt>Type</dt>
            <dd>{TYPE_LABEL[conversationType] ?? conversationType}</dd>
          </>
        ) : null}
        {participantCount !== undefined ? (
          <>
            <dt>People</dt>
            <dd>
              {participantCount} {participantCount === 1 ? 'participant' : 'participants'}
            </dd>
          </>
        ) : null}
        {lastActivityAt !== undefined ? (
          <>
            <dt>Last activity</dt>
            <dd>{auditWhen(lastActivityAt)}</dd>
          </>
        ) : null}
        <dt>Your access</dt>
        {/* Named rather than implied. An administrator should be able to say, from the
            screen, exactly which authority they are exercising. */}
        <dd>Communication oversight · read-only</dd>
      </dl>
    </section>
  );
}

/**
 * Who was in the conversation, from where, and for how long.
 *
 * `effectiveTo` is the part a member list cannot say. Somebody who left the group in March
 * is not a member today and is absolutely part of the answer to "who saw this", so a row
 * that has ended is shown rather than filtered out — marked as ended, with the date.
 */
function Roster({ conversationId }: { readonly conversationId: string }): ReactNode {
  const [people, setPeople] = useState<readonly AuditParticipant[]>([]);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setProblem(undefined);
    void auditApi
      .participants(conversationId)
      .then((answer) => {
        if (!live) return;
        setPeople(answer.participants);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setPeople([]);
        setProblem(describeAuditFailure(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [conversationId, attempt]);

  const present = people.filter((person) => person.effectiveTo === undefined).length;

  return (
    <section className="details-section">
      <h3 className="details-section-title">
        Participants
        {!loading && problem === undefined && people.length > 0 ? (
          <span className="details-count">
            {present}
            {people.length > present ? ` of ${people.length}` : ''}
          </span>
        ) : null}
      </h3>
      {problem !== undefined ? (
        <AuditProblem error={problem} onRetry={() => setAttempt((n) => n + 1)} />
      ) : loading ? (
        <p className="details-empty">Loading…</p>
      ) : people.length === 0 ? (
        <p className="details-empty">This conversation has no participation records.</p>
      ) : (
        <ul className="oversight-roster">
          {people.map((person) => (
            <li key={`${person.principalId}-${person.effectiveFrom}`}>
              <span className="oversight-roster-name">
                {person.displayName ?? person.principalId}
                {/* A customer in a customer conversation is not an employee, and an audit
                    that could not tell them apart would be reading the wrong side of it. */}
                {person.principalKind !== 'EMPLOYEE' ? (
                  <span className="oversight-tag">{person.principalKind.toLowerCase()}</span>
                ) : null}
                {person.effectiveTo !== undefined ? (
                  <span className="oversight-tag">left</span>
                ) : null}
              </span>
              <span className="oversight-row-where">
                {person.department ?? 'No department'} · {person.role.toLowerCase()}
                {person.replyAuthority ? ' · may reply' : ''}
              </span>
              <span className="oversight-row-where">
                Joined {auditWhen(person.effectiveFrom)}
                {person.effectiveTo !== undefined ? ` · left ${auditWhen(person.effectiveTo)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Which of the three an attachment is, from what the server recorded about it. */
function kindOf(file: AuditAttachment): 'image' | 'voice' | 'file' {
  const type = file.contentType ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/') || file.durationMs !== undefined) return 'voice';
  return 'file';
}

/**
 * Everything attached to the conversation, with the state the scanner left it in.
 *
 * Deliberately NOT the ordinary `SharedFiles` panel, which asks the employee attachment
 * route and shows what a participant may open. This asks the audit route, which answers for
 * a reader who is not a participant, and it shows `state` — QUARANTINED and INFECTED are
 * facts an investigation needs and a sharing panel has no reason to print.
 *
 * Names and metadata only. No URL and no thumbnail: the panel says what exists, and opening
 * it is a separate, separately-decided, separately-recorded act.
 */
function Files({ conversationId }: { readonly conversationId: string }): ReactNode {
  const [rows, setRows] = useState<readonly { message: AuditMessage; file: AuditAttachment }[]>([]);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setProblem(undefined);
    void auditApi
      .messages(conversationId, { kind: 'ATTACHMENT', limit: 200 })
      .then((answer) => {
        if (!live) return;
        setRows(
          answer.messages.flatMap((message) =>
            message.attachments.map((file) => ({ message, file })),
          ),
        );
      })
      .catch((error: unknown) => {
        if (!live) return;
        setRows([]);
        setProblem(describeAuditFailure(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [conversationId, attempt]);

  /* Counted by kind, because "eleven attachments" and "nine pictures and two voice notes"
     answer different questions and the second is the one somebody is asking. */
  const tally = rows.reduce<Record<string, number>>((acc, row) => {
    const kind = kindOf(row.file);
    acc[kind] = (acc[kind] ?? 0) + 1;
    return acc;
  }, {});
  const summary = [
    tally['image'] !== undefined ? `${tally['image']} image${tally['image'] === 1 ? '' : 's'}` : '',
    tally['voice'] !== undefined
      ? `${tally['voice']} voice note${tally['voice'] === 1 ? '' : 's'}`
      : '',
    tally['file'] !== undefined ? `${tally['file']} file${tally['file'] === 1 ? '' : 's'}` : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');

  return (
    <section className="details-section">
      <h3 className="details-section-title">
        Shared media
        {rows.length > 0 ? <span className="details-count">{rows.length}</span> : null}
      </h3>
      {problem !== undefined ? (
        <AuditProblem error={problem} onRetry={() => setAttempt((n) => n + 1)} />
      ) : loading ? (
        <p className="details-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="details-empty">Nothing was attached to this conversation.</p>
      ) : (
        <>
          <p className="oversight-row-where">{summary}</p>
          <ul className="oversight-files">
            {rows.map(({ message, file }) => (
              <li key={file.attachmentId}>
                <span className="oversight-roster-name">
                  {file.filename ?? 'Unnamed file'}
                  <span className="oversight-tag">{kindOf(file)}</span>
                </span>
                <span className="oversight-row-where">
                  {file.contentType ?? 'unknown type'}
                  {file.durationMs !== undefined ? ` · ${Math.round(file.durationMs / 1000)}s` : ''}
                  {file.bytes !== undefined ? ` · ${Math.round(file.bytes / 1024)} KB` : ''}
                  {` · ${file.state.toLowerCase()}`}
                </span>
                <span className="oversight-row-where">
                  {message.senderDisplayName} · {auditWhen(message.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
