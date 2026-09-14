'use client';

/**
 * The communication audit console.
 *
 * ## Read-only, and it looks it
 *
 * There is no composer, no reaction control, no menu on a message, nothing to press that
 * would change anything — not because those are hidden, but because they were never built
 * into this screen. The server refuses every write from this role regardless (see
 * `audit-access.ts` and the action sweep in `audit-read-only.test.ts`); what this file adds
 * is that the interface does not offer what the server would refuse. A disabled Send button
 * would be a worse answer: it teaches somebody the product is broken rather than that this
 * is a different job.
 *
 * ## Why it deliberately does not look like the workspace
 *
 * Reading a colleague's one-to-one is not the same act as reading your own thread, and an
 * interface that made the two feel identical would be doing the person using it a
 * disservice. The reader is a transcript — flat, dense, timestamped, with the internal
 * notes marked — rather than a chat with bubbles. Every screen here also says, in the
 * footer, that the read is recorded.
 *
 * ## The permission call is not the protection
 *
 * `auditApi.permission()` decides whether to render the console or a refusal. That is a
 * courtesy to the ordinary employee who followed a link, not a security boundary: every
 * request below is decided again, server-side, per call. The brief is explicit that hiding
 * a screen is never authorization, and this comment is here because that is exactly the
 * line a future change is most likely to cross.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  auditApi,
  type AuditConversation,
  type AuditEmployee,
  type AuditLedgerEvent,
  type AuditMessage,
  type AuditParticipant,
  type AuditSearchHit,
  type AuditTeam,
} from '../../lib/api-client';

type Tab = 'conversations' | 'people' | 'search' | 'ledger';

const TYPES = [
  { id: '', label: 'Any type' },
  { id: 'INTERNAL_DIRECT', label: 'One-to-one' },
  { id: 'INTERNAL_GROUP', label: 'Group' },
  { id: 'INTERNAL_CHANNEL', label: 'Channel' },
  { id: 'INTERNAL_ANNOUNCEMENT', label: 'Announcement' },
  { id: 'CUSTOMER_CLAIM', label: 'Customer — claim' },
  { id: 'CUSTOMER_SERVICE', label: 'Customer — service' },
  { id: 'CUSTOMER_GRIEVANCE', label: 'Customer — grievance' },
];

const KINDS = [
  { id: 'ALL', label: 'Everything' },
  { id: 'TEXT', label: 'Text only' },
  { id: 'ATTACHMENT', label: 'With files' },
  { id: 'VOICE', label: 'Voice notes' },
];

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function AuditConsole(): React.JSX.Element {
  const [allowed, setAllowed] = useState<boolean | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('conversations');

  useEffect(() => {
    void auditApi
      .permission()
      .then((answer) => setAllowed(answer.mayAudit))
      .catch(() => setAllowed(false));
  }, []);

  if (allowed === undefined) {
    return (
      <main className="audit">
        <p className="audit-note">Checking…</p>
      </main>
    );
  }

  if (!allowed) {
    /* The ordinary employee who followed a link. Said plainly rather than with a 404 screen:
       they have not done anything wrong, and the surface exists. */
    return (
      <main className="audit">
        <div className="audit-refused">
          <h1>Not available to this account</h1>
          <p>
            The communication audit is restricted to the organisation&rsquo;s auditor. Every
            request it makes is decided by the server, so this is what you would see whether
            or not this page were here.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="audit">
      <header className="audit-head">
        <div>
          <h1>Communication audit</h1>
          <p>Read-only. Every view is recorded in the audit ledger.</p>
        </div>
        <nav className="audit-tabs" aria-label="Audit sections">
          {(
            [
              ['conversations', 'Conversations'],
              ['people', 'People and teams'],
              ['search', 'Search'],
              ['ledger', 'Access log'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`audit-tab${tab === id ? ' is-on' : ''}`}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'conversations' ? <Conversations /> : null}
      {tab === 'people' ? <People /> : null}
      {tab === 'search' ? <Search /> : null}
      {tab === 'ledger' ? <Ledger /> : null}
    </main>
  );
}

/** The browser: filter on the left, transcript on the right. */
function Conversations(): React.JSX.Element {
  const [employees, setEmployees] = useState<readonly AuditEmployee[]>([]);
  const [teams, setTeams] = useState<readonly AuditTeam[]>([]);
  const [rows, setRows] = useState<readonly AuditConversation[]>([]);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<{
    employeeId: string;
    teamId: string;
    type: string;
    from: string;
    to: string;
  }>({ employeeId: '', teamId: '', type: '', from: '', to: '' });

  useEffect(() => {
    void auditApi.employees().then((answer) => setEmployees(answer.employees)).catch(() => undefined);
    void auditApi.teams().then((answer) => setTeams(answer.teams)).catch(() => undefined);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      /* Only the filters that were set. An empty string is "no filter", not a filter
         matching the empty value — the server's schema would reject the second and the
         difference is invisible until somebody clears a box. */
      const answer = await auditApi.conversations({
        ...(filter.employeeId !== '' ? { employeeId: filter.employeeId } : {}),
        ...(filter.teamId !== '' ? { teamId: filter.teamId } : {}),
        ...(filter.type !== '' ? { type: filter.type } : {}),
        ...(filter.from !== '' ? { from: new Date(filter.from).toISOString() } : {}),
        ...(filter.to !== '' ? { to: new Date(filter.to).toISOString() } : {}),
        limit: 50,
      });
      setRows(answer.conversations);
    } catch {
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="audit-split">
      <section className="audit-side" aria-label="Filters and results">
        <div className="audit-filters">
          <label>
            <span>Employee</span>
            <select
              value={filter.employeeId}
              onChange={(event) => setFilter((f) => ({ ...f, employeeId: event.target.value }))}
            >
              <option value="">Anyone</option>
              {employees.map((person) => (
                <option key={person.principalId} value={person.principalId}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Team</span>
            <select
              value={filter.teamId}
              onChange={(event) => setFilter((f) => ({ ...f, teamId: event.target.value }))}
            >
              <option value="">Any team</option>
              {teams.map((team) => (
                <option key={team.teamId} value={team.teamId}>
                  {team.teamId} ({team.members})
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Type</span>
            <select
              value={filter.type}
              onChange={(event) => setFilter((f) => ({ ...f, type: event.target.value }))}
            >
              {TYPES.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>From</span>
            <input
              type="date"
              value={filter.from}
              onChange={(event) => setFilter((f) => ({ ...f, from: event.target.value }))}
            />
          </label>

          <label>
            <span>To</span>
            <input
              type="date"
              value={filter.to}
              onChange={(event) => setFilter((f) => ({ ...f, to: event.target.value }))}
            />
          </label>
        </div>

        <p className="audit-count">
          {busy ? 'Loading…' : `${rows.length} conversation${rows.length === 1 ? '' : 's'}`}
        </p>

        <ul className="audit-list">
          {rows.map((row) => (
            <li key={row.conversationId}>
              <button
                type="button"
                className={`audit-row${open === row.conversationId ? ' is-on' : ''}`}
                onClick={() => setOpen(row.conversationId)}
              >
                <strong>{row.title ?? 'Untitled conversation'}</strong>
                <span className="audit-meta">
                  {row.conversationType} · {row.participantCount} people · {when(row.lastActivityAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-main" aria-label="Transcript">
        {open === undefined ? (
          <p className="audit-note">Choose a conversation to read its full history.</p>
        ) : (
          <Transcript conversationId={open} />
        )}
      </section>
    </div>
  );
}

/**
 * One conversation, whole.
 *
 * A transcript rather than a chat: flat rows, every timestamp shown, internal notes marked,
 * attachments and voice notes listed as what they are. Reading somebody else's conversation
 * should not feel like being in it.
 */
function Transcript({ conversationId }: { readonly conversationId: string }): React.JSX.Element {
  const [messages, setMessages] = useState<readonly AuditMessage[]>([]);
  const [people, setPeople] = useState<readonly AuditParticipant[]>([]);
  const [kind, setKind] = useState('ALL');
  const [state, setState] = useState<'LOADING' | 'READY' | 'REFUSED'>('LOADING');

  useEffect(() => {
    setState('LOADING');
    void auditApi
      .messages(conversationId, { kind, limit: 200 })
      .then((answer) => {
        setMessages(answer.messages);
        setState('READY');
      })
      .catch(() => setState('REFUSED'));
    void auditApi
      .participants(conversationId)
      .then((answer) => setPeople(answer.participants))
      .catch(() => undefined);
  }, [conversationId, kind]);

  return (
    <div className="audit-transcript">
      <header className="audit-transcript-head">
        <div className="audit-people">
          {people.map((person) => (
            <span key={`${person.principalId}-${person.effectiveFrom}`} className="audit-person">
              {person.displayName ?? person.principalId}
              {/* A participation that ENDED is the fact an audit most often needs: who could
                  see this, and until when. */}
              {person.effectiveTo !== undefined ? <em> · left {when(person.effectiveTo)}</em> : null}
            </span>
          ))}
        </div>
        <label className="audit-kind">
          <span>Show</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            {KINDS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {state === 'LOADING' ? <p className="audit-note">Loading…</p> : null}
      {state === 'REFUSED' ? <p className="audit-note">That conversation is not available.</p> : null}

      {state === 'READY' ? (
        <ol className="audit-messages">
          {messages.map((message) => (
            <li
              key={message.messageId}
              className={`audit-message${message.visibility === 'INTERNAL' ? ' is-internal' : ''}`}
            >
              <div className="audit-message-head">
                <strong>{message.senderDisplayName}</strong>
                <time dateTime={message.createdAt}>{when(message.createdAt)}</time>
                {message.visibility === 'INTERNAL' ? (
                  <span className="audit-tag">Internal note</span>
                ) : null}
                {message.editedAt !== undefined ? <span className="audit-tag">Edited</span> : null}
                {message.redactedAt !== undefined ? (
                  <span className="audit-tag is-gone">Deleted by sender</span>
                ) : null}
                {message.replyToMessageId !== undefined ? (
                  <span className="audit-tag">Reply</span>
                ) : null}
              </div>

              {message.body !== '' ? <p className="audit-body">{message.body}</p> : null}

              {message.attachments.length > 0 ? (
                <ul className="audit-files">
                  {message.attachments.map((file) => (
                    <li key={file.attachmentId}>
                      {(file.contentType ?? '').startsWith('audio/') ? '🎙' : '📎'}{' '}
                      {file.filename ?? 'Unnamed file'}
                      <span className="audit-meta">
                        {file.contentType ?? 'unknown type'}
                        {file.durationMs !== undefined
                          ? ` · ${Math.round(file.durationMs / 1000)}s`
                          : ''}
                        {file.bytes !== undefined
                          ? ` · ${Math.round(file.bytes / 1024)} KB`
                          : ''}
                        {` · ${file.state}`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function People(): React.JSX.Element {
  const [employees, setEmployees] = useState<readonly AuditEmployee[]>([]);
  const [teams, setTeams] = useState<readonly AuditTeam[]>([]);

  useEffect(() => {
    void auditApi.employees().then((answer) => setEmployees(answer.employees)).catch(() => undefined);
    void auditApi.teams().then((answer) => setTeams(answer.teams)).catch(() => undefined);
  }, []);

  return (
    <div className="audit-columns">
      <section aria-label="Employees">
        <h2>Employees ({employees.length})</h2>
        <table className="audit-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Code</th>
              <th>Department</th>
              <th>Teams</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((person) => (
              <tr key={person.principalId}>
                <td>
                  {person.displayName}
                  {/* Interim identity must be unmistakable for a canonical one
                      (INTEGRATION_CONTRACTS §1 rule 4) — including here. */}
                  {person.authority === 'TEMPORARY_AUTHORITY' ? (
                    <span className="audit-meta"> · interim</span>
                  ) : null}
                </td>
                <td>{person.employeeCode ?? '—'}</td>
                <td>{person.department ?? '—'}</td>
                <td>{person.teams.join(', ') || '—'}</td>
                <td>{person.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Teams">
        <h2>Teams ({teams.length})</h2>
        <table className="audit-table">
          <thead>
            <tr>
              <th>Team</th>
              <th>Department</th>
              <th>Members</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((team) => (
              <tr key={team.teamId}>
                <td>{team.teamId}</td>
                <td>{team.department || '—'}</td>
                <td>{team.members}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Search(): React.JSX.Element {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<readonly AuditSearchHit[]>([]);
  const [searched, setSearched] = useState(false);

  const run = async (): Promise<void> => {
    if (term.trim().length < 2) return;
    try {
      const answer = await auditApi.search(term.trim(), 50);
      setHits(answer.results);
    } catch {
      setHits([]);
    } finally {
      setSearched(true);
    }
  };

  return (
    <div className="audit-search">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <label>
          <span>Search every message in the company</span>
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="A word or phrase"
          />
        </label>
        <button type="submit">Search</button>
      </form>

      {searched ? (
        <p className="audit-count">
          {hits.length} result{hits.length === 1 ? '' : 's'}
        </p>
      ) : null}

      <ul className="audit-hits">
        {hits.map((hit) => (
          <li key={hit.messageId}>
            <div className="audit-message-head">
              <strong>{hit.title ?? 'Untitled conversation'}</strong>
              <time dateTime={hit.createdAt}>{when(hit.createdAt)}</time>
              {hit.visibility === 'INTERNAL' ? <span className="audit-tag">Internal note</span> : null}
            </div>
            <p className="audit-body">{hit.body}</p>
            <span className="audit-meta">{hit.conversationType}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The ledger, including this account's own reads.
 *
 * An auditor who could not see their own trail would be an auditor nobody could audit. The
 * table is append-only by role grant and trigger, so reading it here cannot become editing
 * it.
 */
function Ledger(): React.JSX.Element {
  const [events, setEvents] = useState<readonly AuditLedgerEvent[]>([]);
  const [action, setAction] = useState('');

  useEffect(() => {
    void auditApi
      .log({ ...(action !== '' ? { action } : {}), limit: 150 })
      .then((answer) => setEvents(answer.events))
      .catch(() => setEvents([]));
  }, [action]);

  return (
    <div className="audit-ledger">
      <label className="audit-kind">
        <span>Action</span>
        <input
          type="text"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder="e.g. privileged.conversation.read"
        />
      </label>

      <table className="audit-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Target</th>
            <th>Outcome</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.eventId} className={event.outcome === 'REFUSED' ? 'is-refused' : undefined}>
              <td>{when(event.occurredAt)}</td>
              <td>{event.actorId ?? '—'}</td>
              <td>{event.action}</td>
              <td>
                {event.targetKind}
                <span className="audit-meta"> {event.targetId.slice(0, 8)}</span>
              </td>
              <td>{event.outcome}</td>
              <td>{event.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
