'use client';

/**
 * A team's load and waiting work, in the product (SL-083, doc O-07).
 *
 * O-07 is an outcome, not a screen: *"Leadership can see load and waiting customers —
 * queue and workload visible without a report request."* The operational series have been
 * on Grafana since 2026-08-29, and that satisfies an operator with an ops login. It does
 * not satisfy a team lead sitting in this product, which is what "without a report
 * request" means — so the same four facts the tracker row names (waiting, ownership, SLA,
 * capacity) are rendered here from one authorized read.
 *
 * ## Why this is not a leaderboard
 *
 * SL-083's acceptance criterion says so outright: **"No individual vanity leaderboard
 * required."** Each person's row shows what they are carrying *right now*, because that is
 * the question a lead is answering when they decide who to transfer to (§21.7) or whether
 * cover is needed (§21.9). There is deliberately nothing cumulative here — no conversations
 * closed, no messages sent, no response times per person. Those measure people. These
 * measure work, and the difference is the whole reason the criterion is written down.
 *
 * ## Three of the four facts, and the fourth says why not
 *
 * The tracker row names waiting, ownership, SLA and capacity. SLA is the one that cannot
 * be shown: §23.5 requires the clock to be COMPUTED rather than stored (migration 0005
 * dropped the stored due-times for exactly that reason), and D-SLA has not ratified the
 * targets it would be measured against. So the tile carries the blocker instead of a
 * number — an omitted tile reads as "nothing is late", which is a claim nobody has
 * earned. When D-SLA lands, the tile gets its figure and nothing else changes.
 */
import { useCallback, useEffect, useState } from 'react';
import { teamChannel } from '@starlink/shared-contracts/realtime';

import { api, ApiError, type TeamLoad } from '../lib/api-client';
import { useRoom } from '../lib/use-room';

/** Matches the queue's cadence: the two panels answer the same question. */
const REFRESH_MS = 15_000;

function waitedFor(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`;
}

export function TeamLoadPanel({ teamId }: { readonly teamId: string }): React.JSX.Element {
  const [load, setLoad] = useState<TeamLoad | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      setLoad(await api.teamLoad(teamId));
      setError(undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthenticated) return;
      // Same reasoning as the queue: an empty panel and an unreachable server look
      // identical, and one of them means nobody can see the team is drowning.
      setError('Team load could not be loaded. This is not the same as an idle team.');
    }
  }, [teamId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // §20.7's queue-arrival room. The poll stays: that row is "transport required: No".
  useRoom(teamChannel(teamId), () => void refresh());

  return (
    <section className="team-load" aria-label={`Load for ${teamId}`} style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
      <h2 className="section-title">Team load</h2>

      {error !== undefined ? <p role="alert">{error}</p> : null}

      {load === undefined && error === undefined ? (
        <p className="state-note">Loading…</p>
      ) : null}

      {load !== undefined ? (
        <>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '6px 12px',
              margin: '0 0 10px',
            }}
          >
            <div>
              <dt style={LABEL}>Waiting</dt>
              {/* Zero is stated, never left blank — SL-006's "accurate counts". */}
              <dd style={VALUE}>{load.waiting}</dd>
            </div>
            <div>
              <dt style={LABEL}>Longest wait</dt>
              <dd style={VALUE}>
                {load.oldestWaitSeconds === undefined ? '—' : waitedFor(load.oldestWaitSeconds)}
              </dd>
            </div>
            {/* §23.2: an after-hours arrival carries no response-time promise, so it is
                counted apart rather than folded into a number that implies one. */}
            <div>
              <dt style={LABEL}>Arrived after hours</dt>
              <dd style={VALUE}>{load.afterHoursWaiting}</dd>
            </div>
            <div>
              {/*
                SL-083 names SLA among the four facts, and it is the one that cannot be
                shown yet: §23.5 computes the clock rather than storing it, and D-SLA has
                not ratified the targets it would be measured against. Stated, not omitted
                - a missing tile reads as "nothing is late", which is a claim.
              */}
              <dt style={LABEL}>Past SLA</dt>
              <dd style={{ ...VALUE, fontSize: 13, fontWeight: 400 }}>
                Awaiting targets (D-SLA)
              </dd>
            </div>
          </dl>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <caption style={{ ...LABEL, textAlign: 'left', paddingBottom: 4 }}>
              Open conversations per person
            </caption>
            <thead>
              <tr>
                <th scope="col" style={TH}>Person</th>
                <th scope="col" style={{ ...TH, textAlign: 'right' }}>Open</th>
                <th scope="col" style={{ ...TH, textAlign: 'right' }}>Capacity</th>
              </tr>
            </thead>
            <tbody>
              {load.members.map((member) => (
                <tr key={member.principalId}>
                  <td style={TD}>{member.displayName}</td>
                  <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {member.openConversations}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {/* No configured ceiling means NO ceiling, not a ceiling of zero —
                        the same reading `PgAvailabilityReader` takes at placement. */}
                    {member.capacityUnits === undefined
                      ? '—'
                      : `${member.reservedUnits}/${member.capacityUnits}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {load.members.length === 0 ? <p className="muted">Nobody is on this team.</p> : null}
        </>
      ) : null}
    </section>
  );
}

const LABEL: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-muted)',
  margin: 0,
};

const VALUE: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

const TH: React.CSSProperties = {
  ...LABEL,
  textAlign: 'left',
  borderBottom: '1px solid var(--border)',
  padding: '2px 0',
};

const TD: React.CSSProperties = { padding: '3px 0', borderBottom: '1px solid var(--border)' };
