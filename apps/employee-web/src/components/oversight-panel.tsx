'use client';

/**
 * Communication Oversight — the administrator's inbox onto the company's conversations.
 *
 * ## Why it is an inbox and not an audit console
 *
 * It was a page at `/audit`: its own shell, a filter column, a table of rows and a
 * transcript renderer of its own. Three things were wrong with that. The reader left
 * StarLink to use StarLink; the transcript was a SECOND renderer, so the audit view and the
 * product could disagree about what a conversation contained (they did — nothing in it
 * understood a reply quote, a reaction, an edit or a pin); and a table of ids and timestamps
 * is a compliance dashboard, which is a thing you file rather than a thing you work in.
 *
 * What an administrator actually does with this is browse. So it is shaped like the thing
 * people browse messages in: a place to stand (All, Direct, Groups, Channels), a search, a
 * filter stack, and a dense scannable list whose rows carry a name, a preview and a time.
 * Opening a row moves the THREAD column — the same column every other list opens into,
 * rendering with the product's own message list, attachments and names.
 *
 * ## Why this surface has two columns where every other panel has one
 *
 * All of the above used to be stacked in ONE column: masthead, search, the places to stand,
 * a filter disclosure, then the list. Each part was defensible and the pile was not — with
 * the filters open the list began about two-thirds of the way down a 340px column, so the
 * screen's subject was the smallest thing on it and every act of narrowing pushed the answer
 * further out of sight.
 *
 * Navigating and reading a result are two jobs, so they get two columns. `.oversight-nav`
 * holds the places to stand and the filters — the half that changes rarely and stays still —
 * and the list beside it holds the answer, which is the only part that moves. The shell lays
 * the pair out: see `data-section='oversight'` in `globals.css`, which is also why this is
 * the only section whose shape changed.
 *
 * Below 1100px four columns do not fit, so the stylesheet stacks the navigation back above
 * the list and the masthead's collapse control folds it away. The markup is identical at
 * every width; only the stylesheet knows which arrangement it is in.
 *
 * ## Its rows are the product's rows, literally
 *
 * The list uses `.conversation-row` and its children, which is the chat list's own markup
 * and stylesheet. Not a copy: the same classes, so the avatar, the two-line layout, the
 * hover, the selected card and its accent bar are maintained in exactly one place. A second
 * row style would drift, and the drift would be visible side by side on the same screen.
 *
 * ## What makes it an inspection rather than a conversation
 *
 * The server tells the thread column the reader is not a participant
 * (`viewerIsParticipant`), and that column then offers nothing that would write. Nothing in
 * this file enforces anything.
 *
 * ## The permission call is a courtesy, never the protection
 *
 * `auditApi.permission()` decides whether this panel renders, and the sidebar asks the same
 * question before drawing the row. Neither protects anything: every request below is decided
 * again, server-side, per call, and written to the ledger before any content is read. The
 * brief is explicit that hiding a screen is not authorization — this note is here because
 * that is the line a future change is most likely to cross.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  auditApi,
  type AuditConversation,
  type AuditEmployee,
  type AuditLedgerEvent,
  type AuditSearchHit,
  type AuditTeam,
} from '../lib/api-client';
import { auditWhen, describeAuditFailure } from '../lib/audit-errors';
import { AuditProblem } from './oversight-details';
import { GroupGlyph } from './group-glyph';
import { initialsFor, relativeTime } from './conversation-naming';
import { identityStyle } from '../lib/identity-colour';
import { customerWorkspaceEnabled } from '../lib/runtime-origins';
import { useMediaQuery } from '../lib/use-media-query';

/**
 * The places to stand, in StarLink's own vocabulary.
 *
 * Deliberately NOT a support inbox's vocabulary. The reference this was drawn from offers
 * Open, Closed, Awaiting reply, SLA breached and Unassigned, and every one of those is a
 * fact about a customer ticket. StarLink is where a company talks to itself: an internal
 * thread has no lifecycle at all (BR-23), nobody is assigned to a group chat, and there is
 * no reply anybody is waiting for. Importing those words would have put five filters on the
 * screen that can never be anything but empty.
 *
 * What an internal conversation HAS is a kind, the people in it, and when it last moved.
 * Those are the three things here.
 *
 * `label` names a view where it stands alone — above the list, which is the only thing on
 * screen saying what the list is OF. `short` names it where the group heading has already
 * supplied the noun: under a heading reading "All conversations", a child row repeating
 * "All conversations" says the word twice, and that row is the one meaning "no narrowing at
 * all".
 */
type View = 'all' | 'direct' | 'groups' | 'channels' | 'announcements' | 'customer';

const VIEWS: readonly {
  readonly id: View;
  readonly label: string;
  /** How the row reads inside its group; the label is used where there is no group. */
  readonly short?: string;
  /** The conversation kinds this view stands for; empty means every kind. */
  readonly types: readonly string[];
}[] = [
  { id: 'all', label: 'All conversations', short: 'All', types: [] },
  { id: 'direct', label: 'Direct chats', types: ['INTERNAL_DIRECT'] },
  { id: 'groups', label: 'Groups', types: ['INTERNAL_GROUP'] },
  { id: 'channels', label: 'Channels', types: ['INTERNAL_CHANNEL'] },
  { id: 'announcements', label: 'Announcements', types: ['INTERNAL_ANNOUNCEMENT'] },
  {
    id: 'customer',
    label: 'Customer conversations',
    /*
       STAGE 2 ONLY. Not rendered while `customerWorkspaceEnabled()` is false, which is the
       stage this product is actually in — see `runtime-origins.ts` for the rollout decision
       and why it is a setting rather than deleted code. Stage 1 is employee-to-employee, so
       offering a destination for customer threads would be promising a kind of conversation
       that does not exist yet.

       Five kinds behind one row, because to somebody auditing they are one thing: a thread
       with somebody outside the company in it. The server takes a single `type`, so this
       view sends none and narrows in the browser — the only view that does.
    */
    types: [
      'CUSTOMER_SERVICE',
      'CUSTOMER_SALES',
      'CUSTOMER_RENEWAL',
      'CUSTOMER_CLAIM',
      'CUSTOMER_GRIEVANCE',
      'CUSTOMER_GENERAL',
    ],
  },
];

/** How a conversation kind reads on a row. */
const TYPE_LABEL: Readonly<Record<string, string>> = {
  INTERNAL_DIRECT: 'Direct',
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

const isGroupish = (type: string): boolean => type !== 'INTERNAL_DIRECT';

/**
 * What to call a conversation.
 *
 * A title when it has one. Otherwise the people in it — which is how a one-to-one and most
 * groups are named everywhere else in the product, and the only thing that makes a column of
 * fifty threads tell one from another. Falling straight to the kind produced fifty rows
 * reading "One-to-one", which is a list nobody can work from.
 *
 * `and N more` only where the total is known: a search hit carries names and no count, and
 * inventing "and some more" would be worse than the honest list.
 */
export function oversightTitle(row: AuditConversation): string {
  return conversationName(row.title, row.participants, row.conversationType, row.participantCount);
}

function hitConversationName(hit: AuditSearchHit): string {
  return conversationName(hit.title, hit.participants, hit.conversationType);
}

function conversationName(
  title: string | null,
  names: readonly string[] | undefined,
  conversationType: string,
  participantCount?: number,
): string {
  if (title !== null && title !== '') return title;
  const people = names ?? [];
  if (people.length === 0) return TYPE_LABEL[conversationType] ?? 'Untitled conversation';
  const rest = (participantCount ?? people.length) - people.length;
  return rest > 0 ? `${people.join(', ')} and ${rest} more` : people.join(', ');
}

interface Filter {
  readonly employeeId: string;
  readonly teamId: string;
  readonly department: string;
  readonly from: string;
  readonly to: string;
  readonly sort: 'recent' | 'oldest';
}

const NO_FILTER: Filter = {
  employeeId: '',
  teamId: '',
  department: '',
  from: '',
  to: '',
  sort: 'recent',
};

/** Everything except the ordering — a sort is not a narrowing, so it does not count as one. */
const narrowingCount = (filter: Filter): number =>
  [filter.employeeId, filter.teamId, filter.department, filter.from, filter.to].filter(
    (value) => value !== '',
  ).length;

export function OversightPanel({
  activeId,
  onOpen,
  onLoaded,
  onOpenMyChats,
}: {
  readonly activeId?: string | undefined;
  readonly onOpen: (conversationId: string) => void;
  /**
   * Handed up to the shell, which needs the row's own facts to name the thread column.
   *
   * Not a second fetch: this panel has them already. An inspected conversation is in none of
   * the shell's other lists — that is what makes it an inspection — so without this the
   * header above the transcript reads "Conversation" with a dot for an avatar.
   */
  readonly onLoaded: (conversations: readonly AuditConversation[]) => void;
  /** Back to the administrator's OWN conversations, which are an ordinary employee's. */
  readonly onOpenMyChats: () => void;
}): ReactNode {
  /**
   * Three answers, not two.
   *
   * This was a boolean, and a failed permission call set it to `false` — so an administrator
   * whose request did not arrive was told "not available to this account". Telling somebody
   * they lack a permission they hold is worse than telling them nothing: it is a confident
   * answer, and it is wrong.
   */
  const [allowed, setAllowed] = useState<'CHECKING' | 'YES' | 'NO' | 'FAILED'>('CHECKING');
  const [permissionProblem, setPermissionProblem] = useState<string | undefined>(undefined);

  const check = useCallback((): void => {
    setAllowed('CHECKING');
    void auditApi
      .permission()
      .then((answer) => setAllowed(answer.mayAudit ? 'YES' : 'NO'))
      .catch((error: unknown) => {
        setPermissionProblem(describeAuditFailure(error));
        setAllowed('FAILED');
      });
  }, []);

  useEffect(check, [check]);

  /*
     Granted, the surface is the two columns and nothing above them.

     There was a masthead reading "Communication Oversight" across the whole panel, which is
     a title the reader has already been given twice — the rail's selected destination says
     Oversight, and the thread column badges every transcript it opens as an inspection. What
     it cost was the top of the column it sat on, and the two columns below it name
     themselves. The sentence that genuinely has to be on screen, that this is recorded, went
     with the navigation rather than with the title.
  */
  if (allowed === 'YES') {
    return (
      <section className="panel oversight" aria-label="Communication Oversight">
        <Inbox
          {...(activeId !== undefined ? { activeId } : {})}
          onOpen={onOpen}
          onLoaded={onLoaded}
          onOpenMyChats={onOpenMyChats}
        />
      </section>
    );
  }

  return (
    <section className="panel oversight" aria-label="Communication Oversight">
      <header className="panel-head oversight-head">
        <span className="oversight-head-text">
          <h2>Communication Oversight</h2>
          {/*
            Said on the surface itself, every time it is open. Somebody exercising this
            capability should not have to remember that it is recorded — and the people whose
            conversations it reaches are entitled to have it stated plainly.
          */}
          <p>Read-only · every view is recorded</p>
        </span>
      </header>

      {allowed === 'CHECKING' ? <p className="state-note">Checking your access…</p> : null}

      {allowed === 'FAILED' ? (
        <AuditProblem error={permissionProblem ?? 'Something went wrong.'} onRetry={check} />
      ) : null}

      {allowed === 'NO' ? (
        /* The ordinary employee who arrived here somehow. Said plainly rather than as an
           error: they have done nothing wrong, and the capability exists. */
        <p className="state-note">
          Communication oversight is restricted to the organisation&rsquo;s administrator. Every
          request it makes is decided by the server, so this is what you would see whether or
          not this panel were here.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The inbox: a navigation column, and the list it narrows.
 *
 * One list with two sources, deliberately. "Find the thread" and "find the sentence" are the
 * same errand at different resolutions, and the old console made them separate tabs — so
 * finding a message told you which conversation it was in and then made you go and look for
 * it. Here a search hit IS a way into the conversation.
 */
function Inbox({
  activeId,
  onOpen,
  onLoaded,
  onOpenMyChats,
}: {
  readonly activeId?: string | undefined;
  readonly onOpen: (conversationId: string) => void;
  readonly onLoaded: (conversations: readonly AuditConversation[]) => void;
  readonly onOpenMyChats: () => void;
}): ReactNode {
  const [employees, setEmployees] = useState<readonly AuditEmployee[]>([]);
  const [teams, setTeams] = useState<readonly AuditTeam[]>([]);
  const [rows, setRows] = useState<readonly AuditConversation[]>([]);
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>({});
  const [view, setView] = useState<View>('all');
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [busy, setBusy] = useState(true);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [optionsProblem, setOptionsProblem] = useState<string | undefined>(undefined);

  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<readonly AuditSearchHit[] | undefined>(undefined);
  const [searchProblem, setSearchProblem] = useState<string | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  /*
     The field lives behind the masthead's magnifier.

     A search box costs a row of a 300px column permanently and is empty on most visits.
     Opening it puts the caret in it: a magnifier that reveals a field you then have to click
     is two gestures for one intention, which is the commonest way this pattern is got wrong.
  */
  const [searchOpen, setSearchOpen] = useState(false);
  const searchField = useRef<HTMLInputElement>(null);

  /**
   * The access log is a SECOND surface, not a tab beside the conversations.
   *
   * It was one of three equal tabs, which made the first thing an administrator saw a choice
   * between reading the company's conversations and reading a table of audit events. The
   * ledger matters — it is what makes this capability answerable for — and it is still one
   * click away, from the list column's own masthead. It is simply not the product.
   */
  const [showLedger, setShowLedger] = useState(false);

  /** The places to stand fold away. The filters below them do not, so they stay findable. */
  const [viewsOpen, setViewsOpen] = useState(true);

  /**
   * Whether the navigation column is open — a choice, until somebody makes one.
   *
   * `undefined` is not "closed": it is "nobody has said", and until somebody does the WIDTH
   * decides. Four columns do not fit under 1100px, so below that the navigation starts folded
   * to its masthead and the list gets the room; above it the navigation starts open. Once a
   * person presses the control their answer sticks at every width, because a preference the
   * layout keeps overruling is not a preference.
   *
   * `useMediaQuery` reports false until it has mounted (see its own note), which resolves
   * here to the open, desktop composition — the arrangement that must not flicker.
   */
  const narrowShell = useMediaQuery('(max-width: 1100px)');
  const [navChoice, setNavChoice] = useState<boolean | undefined>(undefined);
  const navOpen = navChoice ?? !narrowShell;

  useEffect(() => {
    if (searchOpen) searchField.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    /* The filter options. A failure here does not empty the panel — the list is the point —
       but it must not be silent either, or the filters simply appear to have no options. */
    void auditApi
      .employees()
      .then((answer) => setEmployees(answer.employees))
      .catch((error: unknown) => setOptionsProblem(describeAuditFailure(error)));
    void auditApi
      .teams()
      .then((answer) => setTeams(answer.teams))
      .catch((error: unknown) => setOptionsProblem(describeAuditFailure(error)));
  }, []);

  /* Derived from the teams the audit API already returns rather than asked for separately:
     a department with nobody's team in it has no conversations to filter to. */
  const departments = useMemo(
    () => [...new Set(teams.map((team) => team.department).filter((d) => d !== ''))].sort(),
    [teams],
  );

  /**
   * Stage 1 is employee-to-employee, so there is no customer destination.
   *
   * The same gate the thread page uses for the resolve/transfer/escalate panel, read per
   * render for the same reason `runtimeOrigins` is. Stage 2 is one setting.
   *
   * "All conversations" deliberately still counts and lists EVERY kind. A customer thread
   * in a Stage-1 database would be a leftover rather than a feature — and an oversight
   * surface that silently omitted records would be the worst possible place to draw that
   * distinction. What Stage 1 withholds is a destination, never a record.
   */
  const views = useMemo(
    () => (customerWorkspaceEnabled() ? VIEWS : VIEWS.filter((entry) => entry.id !== 'customer')),
    [],
  );
  const current = views.find((v) => v.id === view) ?? views[0]!;
  const viewTypes = current.types;
  /* One kind narrows in SQL; the customer view's five narrow here. See its own note. */
  const serverType = viewTypes.length === 1 ? viewTypes[0] : undefined;

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      /* Only the filters that were set. An empty string is "no filter", not a filter matching
         the empty value — the server's schema would reject the second, and the difference is
         invisible until somebody clears a box. */
      const answer = await auditApi.conversations({
        ...(filter.employeeId !== '' ? { employeeId: filter.employeeId } : {}),
        ...(filter.teamId !== '' ? { teamId: filter.teamId } : {}),
        ...(filter.department !== '' ? { department: filter.department } : {}),
        ...(serverType !== undefined ? { type: serverType } : {}),
        ...(filter.from !== '' ? { from: new Date(filter.from).toISOString() } : {}),
        /* To the END of the chosen day. A bare date parses as midnight, so "to 14 September"
           excluded everything said on the 14th — the commonest single-day audit there is. */
        ...(filter.to !== '' ? { to: new Date(`${filter.to}T23:59:59.999`).toISOString() } : {}),
        sort: filter.sort,
        limit: 100,
      });
      const narrowed =
        viewTypes.length > 1
          ? answer.conversations.filter((row) => viewTypes.includes(row.conversationType))
          : answer.conversations;
      setRows(narrowed);
      setCounts(answer.counts);
      onLoaded(narrowed);
    } catch (error: unknown) {
      /* The list is emptied AND the reason is shown. Emptying alone is what made a stopped
         API look like a company with no conversations in it. */
      setRows([]);
      setProblem(describeAuditFailure(error));
    } finally {
      setBusy(false);
    }
  }, [filter, serverType, viewTypes, onLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const runSearch = async (): Promise<void> => {
    const wanted = term.trim();
    if (wanted.length < 2) {
      setHits(undefined);
      setSearchProblem(undefined);
      return;
    }
    setSearching(true);
    setSearchProblem(undefined);
    try {
      const answer = await auditApi.search(wanted, 50);
      setHits(answer.results);
    } catch (error: unknown) {
      /* "No results" and "the search did not run" are opposite answers to a compliance
         question. Reporting the second as the first is how an audit concludes that nothing
         was said. */
      setHits([]);
      setSearchProblem(describeAuditFailure(error));
    } finally {
      setSearching(false);
    }
  };

  /* Shutting the field puts the conversations back. A closed search box above a column of
     message hits is a result set with nothing on screen saying what it answers. */
  const toggleSearch = (): void =>
    setSearchOpen((was) => {
      if (was) {
        setTerm('');
        setHits(undefined);
        setSearchProblem(undefined);
      }
      return !was;
    });

  const setOne = (key: keyof Filter, value: string): void =>
    setFilter((f) => ({ ...f, [key]: value }));
  const narrowed = narrowingCount(filter);

  /** How many are in a view, from the server's tally. `all` is the sum of the kinds. */
  const countFor = (types: readonly string[]): number =>
    types.length === 0
      ? Object.values(counts).reduce((sum, n) => sum + n, 0)
      : types.reduce((sum, type) => sum + (counts[type] ?? 0), 0);

  return (
    <div className="oversight-columns" data-nav={navOpen ? 'open' : 'collapsed'}>
      <nav className="oversight-nav" aria-label="Inbox">
        <header className="oversight-nav-head">
          <h2>Inbox</h2>
          <button
            type="button"
            className="oversight-icon"
            aria-expanded={navOpen}
            aria-label={navOpen ? 'Collapse the inbox navigation' : 'Expand the inbox navigation'}
            title={navOpen ? 'Collapse' : 'Expand'}
            onClick={() => setNavChoice(!navOpen)}
          >
            {/* A pane with a divider down it: the column this folds away, drawn as itself.
                Which way it goes is in the label rather than in the glyph, so the control does
                not change shape when it changes meaning. */}
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
              <rect
                x="3.5"
                y="4.5"
                width="17"
                height="15"
                rx="2.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path d="M10 4.5v15" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
        </header>

        <div className="oversight-nav-body">
          {/*
            Said on the surface itself, every time it is open. Somebody exercising this
            capability should not have to remember that it is recorded — and the people whose
            conversations it reaches are entitled to have it stated plainly.
          */}
          <p className="oversight-recorded">Read-only · every view is recorded</p>

          <div className="oversight-group">
            <button
              type="button"
              className="oversight-group-head"
              aria-expanded={viewsOpen}
              onClick={() => setViewsOpen((was) => !was)}
            >
              {/* One chevron, turned by the stylesheet on `aria-expanded` — so the open and
                  shut states cannot drift apart in two hand-drawn paths. */}
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
                <path
                  d="M9 6l6 6-6 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>All conversations</span>
            </button>

            {/*
              The places to stand. A stacked list rather than a pill row: five entries each
              carrying a count do not fit across a 236px column, and the count is the half
              that makes the list worth having — "Direct chats" alone says nothing about
              whether it is worth opening.
            */}
            {viewsOpen ? (
              <ul className="oversight-views" aria-label="Which conversations">
                {views.map((entry) => {
                  const n = countFor(entry.types);
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="oversight-view"
                        aria-current={view === entry.id ? 'true' : undefined}
                        onClick={() => setView(entry.id)}
                      >
                        <span>{entry.short ?? entry.label}</span>
                        {n > 0 ? (
                          <span className="oversight-view-count">{n > 999 ? '999+' : n}</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          {/*
            The administrator's OWN conversations, which are an ordinary employee's and live
            in the ordinary place. A single row rather than a group, because it holds nothing:
            it is a door. "And my own chats" is a question somebody asks from this screen, and
            answering it by switching the shell back to Chats is honest about where they
            actually end up.
          */}
          <button type="button" className="oversight-view is-elsewhere" onClick={onOpenMyChats}>
            <span>My chats</span>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                d="M9 6l6 6-6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/*
            The filters, on the surface rather than behind a disclosure.

            They were behind a "Filters" pill, which is the right economy in a single column
            where five controls above a list would bury it. Given a column of their own the
            economy inverts: a shut sheet is a screen that will not say what it is currently
            narrowed BY, and an audit that cannot see its own narrowing is an audit whose
            answer nobody can check. Each control states its name above itself, and the one
            that undoes all of them appears only when there is something to undo.
          */}
          <div className="oversight-filters">
            <h3 className="oversight-filters-head">Filters</h3>

            <label>
              <span>Team member</span>
              <select
                value={filter.employeeId}
                onChange={(event) => setOne('employeeId', event.target.value)}
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
                onChange={(event) => setOne('teamId', event.target.value)}
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
              <span>Department</span>
              <select
                value={filter.department}
                onChange={(event) => setOne('department', event.target.value)}
              >
                <option value="">Any department</option>
                {departments.map((department) => (
                  <option key={department} value={department}>
                    {department}
                  </option>
                ))}
              </select>
            </label>

            {/* Two dates are one question, so they sit side by side under one name rather
                than as two unrelated fields that happen to be adjacent. */}
            <div className="oversight-dates" role="group" aria-label="Date range">
              <label>
                <span>From</span>
                <input
                  type="date"
                  value={filter.from}
                  onChange={(event) => setOne('from', event.target.value)}
                />
              </label>
              <label>
                <span>To</span>
                <input
                  type="date"
                  value={filter.to}
                  onChange={(event) => setOne('to', event.target.value)}
                />
              </label>
            </div>

            {narrowed > 0 ? (
              <button
                type="button"
                className="oversight-clear"
                onClick={() => setFilter((f) => ({ ...NO_FILTER, sort: f.sort }))}
              >
                Clear {narrowed} filter{narrowed === 1 ? '' : 's'}
              </button>
            ) : null}

            {optionsProblem !== undefined ? <AuditProblem error={optionsProblem} /> : null}
          </div>
        </div>
      </nav>

      <div className="oversight-main">
        {/*
          The list column names itself, because the navigation beside it is a set of places
          and this is the one being stood in. Its three controls are the three things that act
          on THIS list — what it contains, what order it is in, and the record of who has read
          it — which is why none of them is in the navigation column.
        */}
        <header className="oversight-list-head">
          <h3>{showLedger ? 'Access log' : current.label}</h3>

          {showLedger ? (
            <button
              type="button"
              className="oversight-icon"
              title="Back to conversations"
              aria-label="Back to conversations"
              onClick={() => setShowLedger(false)}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
                <path
                  d="M14 6l-6 6 6 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : (
            <>
              <button
                type="button"
                className="oversight-icon"
                aria-pressed={searchOpen}
                title="Search every message"
                aria-label="Search every message"
                onClick={toggleSearch}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="17"
                  height="17"
                  aria-hidden="true"
                  focusable="false"
                >
                  <circle
                    cx="11"
                    cy="11"
                    r="6.2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                  <path
                    d="m15.6 15.6 4 4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>

              {/*
                Order, as a button rather than as the select it was.

                There are exactly two orderings, and a two-option select in a masthead spends
                a third of the row announcing a choice it could simply hold. The label states
                which order the list is IN rather than what pressing will do, because the
                first is the question somebody scanning a column of dates actually has; the
                bars and the arrow follow the same answer.
              */}
              <button
                type="button"
                className="oversight-icon"
                title={filter.sort === 'recent' ? 'Newest first' : 'Oldest first'}
                aria-label={
                  filter.sort === 'recent'
                    ? 'Ordered newest first — show oldest first'
                    : 'Ordered oldest first — show newest first'
                }
                onClick={() => setOne('sort', filter.sort === 'recent' ? 'oldest' : 'recent')}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="17"
                  height="17"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    d={filter.sort === 'recent' ? 'M4 7h11M4 12h8M4 17h5' : 'M4 7h5M4 12h8M4 17h11'}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <path
                    d={
                      filter.sort === 'recent'
                        ? 'M18.6 6v12m0 0 2.2-2.5m-2.2 2.5-2.2-2.5'
                        : 'M18.6 18V6m0 0 2.2 2.5M18.6 6l-2.2 2.5'
                    }
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              <button
                type="button"
                className="oversight-icon"
                title="Access log"
                aria-label="Access log"
                onClick={() => setShowLedger(true)}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="17"
                  height="17"
                  aria-hidden="true"
                  focusable="false"
                >
                  <circle cx="12" cy="5.6" r="1.6" fill="currentColor" />
                  <circle cx="12" cy="12" r="1.6" fill="currentColor" />
                  <circle cx="12" cy="18.4" r="1.6" fill="currentColor" />
                </svg>
              </button>
            </>
          )}
        </header>

        {showLedger ? (
          <Ledger />
        ) : (
          <>
            {searchOpen ? (
              <div className="search oversight-search">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runSearch();
                  }}
                >
                  <label className="sr-only" htmlFor="oversight-search">
                    Search every message in the company
                  </label>
                  <input
                    id="oversight-search"
                    ref={searchField}
                    type="search"
                    value={term}
                    placeholder="Search every message…"
                    onChange={(event) => {
                      setTerm(event.target.value);
                      /* Clearing the box returns the list to conversations rather than
                         leaving the last search on screen above an empty field. */
                      if (event.target.value.trim() === '') {
                        setHits(undefined);
                        setSearchProblem(undefined);
                      }
                    }}
                  />
                </form>
              </div>
            ) : null}

            <div className="panel-body oversight-body">
              {hits !== undefined ? (
                <>
                  {searchProblem !== undefined ? (
                    <AuditProblem error={searchProblem} onRetry={() => void runSearch()} />
                  ) : (
                    <p className="oversight-count">
                      {searching
                        ? 'Searching…'
                        : `${hits.length} message${hits.length === 1 ? '' : 's'} matching “${term.trim()}”`}
                    </p>
                  )}
                  <ul className="oversight-list">
                    {hits.map((hit) => (
                      <li key={hit.messageId}>
                        <button
                          type="button"
                          className="conversation-row"
                          aria-current={activeId === hit.conversationId ? 'page' : undefined}
                          onClick={() => onOpen(hit.conversationId)}
                        >
                          <Avatar
                            id={hit.conversationId}
                            name={hit.senderDisplayName ?? hitConversationName(hit)}
                            group={isGroupish(hit.conversationType)}
                          />
                          <span className="row-text">
                            <span className="row-top">
                              <strong className="row-name">
                                {hit.senderDisplayName ?? 'Unknown sender'}
                              </strong>
                              <time dateTime={hit.createdAt} className="row-time">
                                {relativeTime(hit.createdAt)}
                              </time>
                            </span>
                            <span className="row-bottom">
                              <span className="row-preview">{hit.body}</span>
                            </span>
                            <span className="oversight-row-where">
                              {hit.visibility === 'INTERNAL' ? (
                                <span className="oversight-tag">internal note</span>
                              ) : null}
                              {hitConversationName(hit)}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!searching && searchProblem === undefined && hits.length === 0 ? (
                    <p className="state-note">
                      Nothing in the company&rsquo;s messages matches that. Try fewer words.
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  {problem !== undefined ? (
                    <AuditProblem error={problem} onRetry={() => void load()} />
                  ) : (
                    <p className="oversight-count">
                      {busy
                        ? 'Loading…'
                        : `${rows.length} conversation${rows.length === 1 ? '' : 's'}`}
                    </p>
                  )}

                  {problem === undefined && !busy && rows.length === 0 ? (
                    /* A genuine absence, said as one. Distinguishable from the failure above
                       it, which is the whole point of this panel knowing the difference. */
                    <p className="state-note">
                      No conversations here. Widen the dates, clear a filter, or choose another
                      view.
                    </p>
                  ) : null}

                  <ul className="oversight-list">
                    {rows.map((row) => (
                      <li key={row.conversationId}>
                        <button
                          type="button"
                          className="conversation-row"
                          aria-current={activeId === row.conversationId ? 'page' : undefined}
                          onClick={() => onOpen(row.conversationId)}
                        >
                          <Avatar
                            id={row.conversationId}
                            name={oversightTitle(row)}
                            group={isGroupish(row.conversationType)}
                          />
                          <span className="row-text">
                            <span className="row-top">
                              <strong className="row-name">{oversightTitle(row)}</strong>
                              <time
                                dateTime={row.lastActivityAt}
                                className="row-time"
                                title={new Date(row.lastActivityAt).toLocaleString()}
                              >
                                {relativeTime(row.lastActivityAt)}
                              </time>
                            </span>
                            <span className="row-bottom">
                              <span className="row-preview">
                                {row.lastMessagePreview === undefined ? (
                                  <em className="muted">No messages</em>
                                ) : (
                                  <>
                                    {row.lastMessageSender !== undefined ? (
                                      <strong>{row.lastMessageSender}: </strong>
                                    ) : null}
                                    {row.lastMessagePreview}
                                  </>
                                )}
                              </span>
                            </span>
                            {/*
                              The third line is what an oversight row has that a chat row does
                              not: which KIND of conversation this is, how many people are in
                              it, and which departments they come from. On your own list those
                              are things you know; on somebody else's they are the reason you
                              are looking.
                            */}
                            <span className="oversight-row-where">
                              <span className="oversight-tag">
                                {TYPE_LABEL[row.conversationType] ?? row.conversationType}
                              </span>
                              {row.participantCount}{' '}
                              {row.participantCount === 1 ? 'person' : 'people'}
                              {(row.departments ?? []).length > 0
                                ? ` · ${(row.departments ?? []).join(', ')}`
                                : ''}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The same avatar the chat list draws, on the same classes.
 *
 * Hashed on the conversation so a group has one recognisable colour, exactly as
 * `conversation-list.tsx` does it — a column of identical grey circles is how a list of
 * fifty threads becomes unreadable, and that lesson is already learned once in this product.
 *
 * No photograph. `AvatarImage` needs a principal id and the audit list carries names rather
 * than ids; initials over a hashed ground is the fallback the rest of the product already
 * uses when the picture is unknown, so this reads as that case rather than as a new one.
 */
function Avatar({
  id,
  name,
  group,
}: {
  readonly id: string;
  readonly name: string;
  readonly group: boolean;
}): ReactNode {
  return (
    <span className="avatar-wrap">
      <span
        className={`row-avatar identity${group ? ' group' : ''}`}
        aria-hidden="true"
        style={identityStyle(id)}
      >
        {group ? <GroupGlyph /> : initialsFor(name)}
      </span>
    </span>
  );
}

/**
 * The ledger, including this account's own reads.
 *
 * An auditor who could not see their own trail would be an auditor nobody could audit. The
 * table is append-only by role grant and by trigger (rule 8), so reading it here cannot
 * become editing it.
 *
 * It takes the LIST column, behind the masthead's overflow control — see `showLedger` for
 * why the audit record is not the first thing this surface shows. The navigation column
 * stays put beside it, which is what makes this a second view of one surface rather than a
 * second screen somebody has to find their way back out of.
 */
function Ledger(): ReactNode {
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
        setProblem(describeAuditFailure(error));
      });
  }, [action, attempt]);

  return (
    <>
      <div className="search oversight-search">
        <label className="sr-only" htmlFor="oversight-ledger-action">
          Filter by action
        </label>
        <input
          id="oversight-ledger-action"
          type="search"
          value={action}
          placeholder="Any action — e.g. privileged.conversation.read"
          onChange={(event) => setAction(event.target.value)}
        />
      </div>

      <div className="panel-body oversight-body">
        {problem !== undefined ? (
          <AuditProblem error={problem} onRetry={() => setAttempt((n) => n + 1)} />
        ) : (
          <p className="oversight-count">
            {events.length} event{events.length === 1 ? '' : 's'}
          </p>
        )}

        <ul className="oversight-list">
          {events.map((event) => (
            <li key={event.eventId}>
              <div className={`oversight-event${event.outcome === 'REFUSED' ? ' is-refused' : ''}`}>
                <span className="oversight-event-top">
                  <strong>{event.action}</strong>
                  <span className="oversight-tag">{event.outcome.toLowerCase()}</span>
                </span>
                <span className="oversight-row-where">
                  {auditWhen(event.occurredAt)} · {event.actorName ?? event.actorId ?? 'no actor'}
                </span>
                <span className="oversight-row-where">
                  {event.targetKind} {event.targetId.slice(0, 8)}
                  {event.reason !== null ? ` · ${event.reason}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
