'use client';

/**
 * What the information panel says about the conversation it sits beside.
 *
 * The design's fourth column has three parts below the identity block: DETAILS, SHARED
 * FILES, and the group's own membership controls (which `Participants` already owns).
 * This file is the first two.
 *
 * ## Every row is evidence, or it is absent
 *
 * The reference draws an Employee ID, a "Reports to", a Location and a Local time. None of
 * those is StarLink's to know — they belong to HRMS, and the directory adapter is the
 * interim stand-in (rule 11). So each row renders only when the directory actually supplied
 * the value: a sparse directory produces a shorter list, never a blank row, an em dash, or
 * a plausible-looking default. Filling the panel to match the picture would mean inventing
 * a business value, which is rule 10 and the one this screen is most tempted to break.
 *
 * ## The local time is computed, never stored
 *
 * The directory carries an IANA zone; the clock is the reader's own. That is deliberate —
 * a time rendered server-side is stale by the time it paints, and an offset is wrong twice
 * a year in every country that shifts. An unrecognised zone renders nothing rather than
 * falling back to the reader's own time, which would be a wrong answer wearing a right
 * one's clothes.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type DirectoryEntry, type SharedFile } from '../lib/api-client';
import { extensionOf, formatBytes } from './attachment-picker';
import { relativeTime } from './conversation-naming';

/**
 * One colleague's directory record, fetched once per principal per page load.
 *
 * Two components want it — the chat header, for the line under the name, and the panel, for
 * DETAILS — and they mount together. Without the cache that is two identical requests every
 * time a conversation is opened, for a record that does not change while you look at it.
 *
 * The cache is a module-level `Map` of PROMISES rather than of values, so two components
 * mounting in the same tick share one in-flight request instead of racing to start two. It
 * lives for the life of the page: a directory correction lands on the next load, which for
 * an employee directory is the right freshness, and holding it any longer would mean
 * inventing an invalidation rule for data StarLink does not own (rule 11).
 *
 * A failure is cached as `undefined` and NOT retried on every render — a refusal (the
 * directory is scoped, FR-EMP-5) would otherwise become a request loop against a route
 * that has already said no.
 */
const directoryCache = new Map<string, Promise<DirectoryEntry | undefined>>();

export function useColleague(principalId: string | undefined): DirectoryEntry | undefined {
  const [entry, setEntry] = useState<DirectoryEntry | undefined>();

  useEffect(() => {
    setEntry(undefined);
    if (principalId === undefined) return;

    let live = true;
    let pending = directoryCache.get(principalId);
    if (pending === undefined) {
      pending = api.colleague(principalId).catch(() => undefined);
      directoryCache.set(principalId, pending);
    }
    void pending.then((found) => {
      if (live) setEntry(found);
    });
    return () => {
      live = false;
    };
  }, [principalId]);

  return entry;
}

/**
 * The colleague's own facts, for a one-to-one.
 *
 * Fetched here rather than threaded down from the shell: the shell holds a conversation
 * SUMMARY, which carries a name and a principal id and nothing else, and widening it to
 * carry a directory record would put HRMS's fields into every list row that never shows
 * them.
 */
export function EmployeeDetails({ principalId }: { readonly principalId: string }): React.JSX.Element | null {
  const entry = useColleague(principalId);

  if (entry === undefined) return null;

  /*
     The reference's four rows, in its order: Employee ID, Reports to, Location, Local time.

     Department and team were in here too, and they are not in the design — the department
     belongs on the line under the NAME, where screen 02 puts it ("Manager, Brand
     Marketing"), and the team is a fact this panel does not need to carry. Six rows where
     the reference draws four made the block a quarter taller than the design and pushed
     Shared files below the fold on a laptop.
  */
  const rows: { label: string; value: string }[] = [];
  if (entry.employeeId !== undefined) rows.push({ label: 'Employee ID', value: entry.employeeId });
  if (entry.reportsTo !== undefined) rows.push({ label: 'Reports to', value: entry.reportsTo });
  if (entry.location !== undefined) rows.push({ label: 'Location', value: entry.location });

  return (
    <section className="details-section">
      <h3 className="details-section-title">Details</h3>
      {rows.length === 0 && entry.timezone === undefined ? (
        <p className="details-empty">
          The directory holds nothing else about this colleague yet.
        </p>
      ) : (
        <dl className="details-list">
          {rows.map((row) => (
            <div className="details-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
          {entry.timezone !== undefined ? <LocalTime zone={entry.timezone} /> : null}
        </dl>
      )}
    </section>
  );
}

/**
 * "Local time" — theirs, live, and only when the zone is one the platform knows.
 *
 * Ticking is per minute and aligned to the next minute boundary rather than to mount, so
 * two panels opened seconds apart do not disagree by a minute.
 */
function LocalTime({ zone }: { readonly zone: string }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const toNextMinute = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60_000);
    }, toNextMinute);
    return () => {
      clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
    };
  }, []);

  let rendered: string;
  try {
    /*
       "11:42 IST" — one line, as the reference draws it.

       The zone used to be a second line spelling out "Asia/Kolkata". That is the identifier,
       not what a person calls the time: it made the one two-line row in DETAILS and named a
       city nobody asked about.

       The abbreviation is appended only when the platform HAS one. ICU answers "GMT+5:30"
       for a zone it cannot name in the reader's locale, and "15:23 GMT+5:30" is half again
       as wide as the row — so in that case the time stands alone, which is the part that was
       being asked for anyway.
    */
    const at = new Date(now);
    const time = new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(at);

    const abbreviation = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;

    rendered =
      abbreviation === undefined || abbreviation.startsWith('GMT') || abbreviation.startsWith('UTC')
        ? time
        : `${time} ${abbreviation}`;
  } catch {
    // An unknown zone is a directory problem, not something to paper over with our own
    // clock — the row simply is not there.
    return null;
  }

  return (
    <div className="details-row">
      <dt>Local time</dt>
      <dd>{rendered}</dd>
    </div>
  );
}

/**
 * Everything shared in this conversation, newest first.
 *
 * The list is metadata only and a download is still a click, for the same reason the
 * message list's is: §28.4 mints a short-lived, single-object, AUDITED grant, so rendering
 * an `href` per row would issue grants nobody asked for and write an audit entry for every
 * file nobody opened.
 *
 * It refetches when the conversation's message count moves, which is how a file shared
 * while the panel is open appears without a reload.
 */
export function SharedFiles({
  conversationId,
  revision,
}: {
  readonly conversationId: string;
  readonly revision: number;
}): React.JSX.Element {
  const [files, setFiles] = useState<readonly SharedFile[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  /*
     The reference shows two files and a "See all". Four is what fits the column without
     pushing the section below it off a laptop screen; the rest are one press away.
  */
  const [all, setAll] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .sharedFiles(conversationId)
      .then((result) => {
        if (live) {
          setFiles(result.files);
          setProblem(undefined);
        }
      })
      .catch(() => {
        if (live) setProblem('Shared files could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [conversationId, revision]);

  return (
    <section className="details-section">
      <h3 className="details-section-title">
        Shared files
        {files !== undefined && files.length > 0 ? (
          <span className="details-count">{files.length}</span>
        ) : null}
        {files !== undefined && files.length > SHOWN && !all ? (
          <button type="button" className="details-more" onClick={() => setAll(true)}>
            See all
          </button>
        ) : null}
      </h3>

      {problem !== undefined ? (
        <p className="details-empty" role="alert">
          {problem}
        </p>
      ) : files === undefined ? (
        <p className="details-empty">Loading…</p>
      ) : files.length === 0 ? (
        <p className="details-empty">Nothing has been shared here yet.</p>
      ) : (
        <ul className="shared-files">
          {(all ? files : files.slice(0, SHOWN)).map((file) => (
            <li key={file.attachmentId}>
              <SharedFileRow file={file} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The reference shows two rows and a "See all"; four is what this column holds. */
const SHOWN = 4;

/**
 * Which tint a file's badge takes.
 *
 * By what the NAME claims it is, and only into three buckets — the reference gives a
 * document and an image different tints, and the value of that is telling a screenshot from
 * a spreadsheet without reading either. Anything unrecognised takes the neutral rather than
 * a guess, which is the same shape as rule 4 one level down.
 *
 * Not a claim about the file's real type: §28.2 sniffs that server-side and the sniffed type
 * is not in this projection. See `extensionOf`.
 */
function toneFor(filename: string): string {
  const extension = extensionOf(filename).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(extension)) return 'image';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt'].includes(extension)) {
    return 'document';
  }
  return 'other';
}

function SharedFileRow({ file }: { readonly file: SharedFile }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  const open = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      const grant = await api.downloadAttachment(file.attachmentId);
      window.open(grant.url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      setProblem(
        cause instanceof ApiError && cause.status === 503
          ? 'Storage is temporarily unavailable. The file is safe — try again shortly.'
          : 'That file is not available to you.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="shared-file" onClick={() => void open()} disabled={busy}>
        <span className={`shared-file-icon ${toneFor(file.filename)}`} aria-hidden="true">
          {extensionOf(file.filename)}
        </span>
        <span className="shared-file-text">
          <span className="shared-file-name">{file.filename}</span>
          {/*
            "Today · 1.8 MB", as the reference draws it — when, then how big.

            It used to be size then uploader. The uploader is not on the reference's row and
            is the less useful of the two here: you are looking for the thing somebody sent
            on Tuesday, and every row in a two-person conversation has the same two names on
            it anyway.
          */}
          <span className="shared-file-meta">
            {relativeTime(file.sharedAt)} · {formatBytes(file.declaredBytes)}
          </span>
        </span>
      </button>
      {problem !== undefined ? (
        <span className="details-empty" role="alert">
          {problem}
        </span>
      ) : null}
    </>
  );
}

/**
 * The line under a colleague's name in the information panel.
 *
 * Screen 02 puts their role there — "Manager, Brand Marketing" — where this panel used to
 * say "Direct message", which is a fact about the CONVERSATION on the one block that is
 * about the PERSON. The directory's department is the closest thing StarLink holds, and it
 * comes from the same cached lookup DETAILS below it uses, so the line costs no request.
 *
 * Nothing rather than a placeholder when the directory has no department: an empty line is
 * better than a made-up job title, and the name above it is the whole of what is known.
 */
export function ColleagueRole({ principalId }: { readonly principalId: string }): React.JSX.Element | null {
  const entry = useColleague(principalId);
  const department = entry?.department;
  if (department === undefined || department === '') return null;
  return <span className="details-identity-meta">{department}</span>;
}
