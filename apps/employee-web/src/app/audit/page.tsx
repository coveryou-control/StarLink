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
  ApiError,
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

/**
 * What went wrong, in words, for a person who is auditing rather than debugging.
 *
 * ## Why this exists at all
 *
 * Every load on this screen used to end in `catch { setRows([]) }`. That turns a stopped
 * API, a 500, a rate limit and a genuine absence of data into the same picture: an empty
 * panel. It was reported exactly as it would have to be — "I cannot see any conversations,
 * the view appears empty" — and there was nothing on the screen to say otherwise, because
 * the screen could not tell the difference either.
 *
 * A read-only audit surface is the worst place for that ambiguity. "There are no
 * conversations" and "I could not ask" are opposite answers to a compliance question, and a
 * view that renders them identically will eventually be believed.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    /* `api-client` wraps a network failure as an ApiError with status 0, so "could not
       reach" arrives here looking like a refusal. Reporting it as "refused" would be the
       same confident-and-wrong answer this whole change exists to stop. */
    if (error.status === 0) {
      return 'Could not reach the API. It may be restarting, or this page may be pointed at a different one.';
    }
    if (error.status === 404) {
      return 'The server declined that request. This account may no longer hold the audit permission.';
    }
    if (error.status === 429) return 'Too many requests at once. Wait a moment and try again.';
    if (error.status >= 500) return `The server failed to answer (${error.status}).`;
    return `The request was refused (${error.status}).`;
  }
  /* A TypeError from `fetch` is the API being unreachable — stopped, restarting, or a
     different origin than this page was built against. The commonest cause by far, and the
     one an empty panel hid completely. */
  return 'Could not reach the API. It may be restarting, or this page may be pointed at a different one.';
}

/** A failure, said plainly, with a way to try again. */
function Problem({
  error,
  onRetry,
}: {
  readonly error: string;
  readonly onRetry?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <p className="audit-problem" role="alert">
      {error}
      {onRetry !== undefined ? (
        <button type="button" onClick={onRetry} className="audit-retry">
          Try again
        </button>
      ) : null}
    </p>
  );
}

export default function AuditConsole(): React.JSX.Element {
  /**
   * Three answers, not two.
   *
   * This was a boolean, and a failed permission call set it to `false` — so an
   * administrator whose request did not arrive was told "Not available to this account".
   * Telling somebody they lack a permission they hold is worse than telling them nothing:
   * it is a confident answer, and it is wrong.
   */
  const [allowed, setAllowed] = useState<'CHECKING' | 'YES' | 'NO' | 'FAILED'>('CHECKING');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('conversations');

  const check = useCallback((): void => {
    setAllowed('CHECKING');
    void auditApi
      .permission()
      .then((answer) => setAllowed(answer.mayAudit ? 'YES' : 'NO'))
      .catch((error: unknown) => {
        setProblem(describe(error));
        setAllowed('FAILED');
      });
  }, []);

  useEffect(check, [check]);

  if (allowed === 'CHECKING') {
    return (
      <main className="audit">
        <p className="audit-note">Checking…</p>
      </main>
    );
  }

  if (allowed === 'FAILED') {
    return (
      <main className="audit">
        <div className="audit-refused">
          <h1>Could not check your access</h1>
          <Problem error={problem ?? 'Something went wrong.'} onRetry={check} />
        </div>
      </main>
    );
  }

  if (allowed === 'NO') {
    /* The ordinary employee who followed a link. Said plainly rather than with a 404 screen:
       they have not done anything wrong, and the surface exists. */
    return (
      <main className="audit">
        <div className="audit-refused">
          <h1>Not available to this account</h1>
          <p>
            The Admin Audit View is restricted to the organisation&rsquo;s administrator.
            Every request it makes is decided by the server, so this is what you would see
            whether or not this page were here.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="audit">
      <header className="audit-head">
        <div>
          <h1>Admin Audit View</h1>
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
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [sideProblem, setSideProblem] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<{
    employeeId: string;
    teamId: string;
    type: string;
    from: string;
    to: string;
  }>({ employeeId: '', teamId: '', type: '', from: '', to: '' });

  useEffect(() => {
    /* The filter dropdowns. A failure here does not empty the screen — the conversation
       list below is the point — but it must not be silent either, or the filters simply
       appear to have no options in them. */
    void auditApi
      .employees()
      .then((answer) => setEmployees(answer.employees))
      .catch((error: unknown) => setSideProblem(describe(error)));
    void auditApi
      .teams()
      .then((answer) => setTeams(answer.teams))
      .catch((error: unknown) => setSideProblem(describe(error)));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
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
    } catch (error: unknown) {
      /* The list is emptied AND the reason is shown. Emptying alone is what made a stopped
         API look like a company with no conversations in it. */
      setRows([]);
      setProblem(describe(error));
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

        {sideProblem !== undefined ? <Problem error={sideProblem} /> : null}

        <p className="audit-count">
          {busy ? 'Loading…' : `${rows.length} conversation${rows.length === 1 ? '' : 's'}`}
        </p>

        {problem !== undefined ? <Problem error={problem} onRetry={() => void load()} /> : null}
        {problem === undefined && !busy && rows.length === 0 ? (
          /* A genuine absence, said as one. Distinguishable from the failure above it,
             which is the whole point of this screen knowing the difference. */
          <p className="audit-note">
            No conversations match these filters. Widen the date range or clear a filter.
          </p>
        ) : null}

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
  const [state, setState] = useState<'LOADING' | 'READY' | 'FAILED'>('LOADING');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setState('LOADING');
    setProblem(undefined);
    void auditApi
      .messages(conversationId, { kind, limit: 200 })
      .then((answer) => {
        setMessages(answer.messages);
        setState('READY');
      })
      .catch((error: unknown) => {
        /* Was `setState('REFUSED')` for every failure, which told the reader the server had
           declined when it may simply not have answered. On an audit surface those are very
           different facts. */
        setProblem(describe(error));
        setState('FAILED');
      });
    void auditApi
      .participants(conversationId)
      .then((answer) => setPeople(answer.participants))
      .catch(() => setPeople([]));
  }, [conversationId, kind, attempt]);

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
      {state === 'FAILED' ? (
        <Problem error={problem ?? 'Could not load.'} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {state === 'READY' && messages.length === 0 ? (
        /* A conversation that genuinely holds nothing — several do, having been created and
           never written in. Said as an absence rather than drawn as a blank panel. */
        <p className="audit-note">
          This conversation has no messages{kind === 'ALL' ? '' : ' of that kind'}.
        </p>
      ) : null}

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
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setProblem(undefined);
    void auditApi
      .employees()
      .then((answer) => setEmployees(answer.employees))
      .catch((error: unknown) => setProblem(describe(error)));
    void auditApi
      .teams()
      .then((answer) => setTeams(answer.teams))
      .catch((error: unknown) => setProblem(describe(error)));
  }, [attempt]);

  if (problem !== undefined) {
    return <Problem error={problem} onRetry={() => setAttempt((n) => n + 1)} />;
  }

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
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const run = async (): Promise<void> => {
    if (term.trim().length < 2) return;
    setProblem(undefined);
    try {
      const answer = await auditApi.search(term.trim(), 50);
      setHits(answer.results);
    } catch (error: unknown) {
      /* "No results" and "the search did not run" are opposite answers to a compliance
         question. Reporting the second as the first is how an audit concludes that nothing
         was said. */
      setHits([]);
      setProblem(describe(error));
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

      {problem !== undefined ? <Problem error={problem} onRetry={() => void run()} /> : null}

      {searched && problem === undefined ? (
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
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setProblem(undefined);
    void auditApi
      .log({ ...(action !== '' ? { action } : {}), limit: 150 })
      .then((answer) => setEvents(answer.events))
      .catch((error: unknown) => {
        setEvents([]);
        setProblem(describe(error));
      });
  }, [action, attempt]);

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

      {problem !== undefined ? (
        <Problem error={problem} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}

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
