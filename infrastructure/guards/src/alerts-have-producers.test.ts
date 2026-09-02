/**
 * Every alert must watch a series something actually emits.
 *
 * ## The failure this ends
 *
 * A Prometheus alert whose series does not exist evaluates over no data and never fires.
 * There is no error, no warning, and no gap on a dashboard — the rule sits in the rules
 * file looking like coverage. It is indistinguishable from health, which makes it strictly
 * worse than having no alert at all: an absent alert is a known gap, and a silent one is a
 * believed guarantee.
 *
 * It had already happened twice here. `MessagePageIndexRegression` watched
 * `starlink_message_page_rows_examined_ratio` from Phase 1 to 2026-08-29, and nothing
 * emitted it — so the single alert guarding §38's paging property, the one §38 calls "the
 * earliest available warning of the exact regression §38 measured", was the alarm that
 * could not ring. `CustomerWaitingBeyondStandard` compared against
 * `starlink_team_waiting_threshold_seconds`, a series nothing produced, until Phase 6.
 * Both were found by reading, which is not a mechanism.
 *
 * ## What this checks, and what it cannot
 *
 * Three things, in order of strength:
 *
 *   1. every series named in `alerts.yml` is a declared metric (catches a typo or a
 *      rename that did not reach the rules file);
 *   2. every such metric has at least one emission site in application source;
 *   3. metric names in the catalogue are unique.
 *
 * It cannot prove the emission ever RUNS — a call site inside a branch nobody reaches
 * satisfies this and still produces nothing. That residual risk is real and is covered
 * where it matters by the tests that assert a series is present after a sweep runs (see
 * `infrastructure/sweeps/src/index-health-sweep.test.ts`, and `employee-exit.test.ts`
 * scraping the live process). The guard's job is the cheap, total sweep: no alert may
 * reference a name that nothing anywhere emits.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, REPO_ROOT } from './source-scan.js';

const ALERTS = join(REPO_ROOT, 'infrastructure', 'monitoring', 'alerts.yml');
const CATALOGUE = join(REPO_ROOT, 'packages', 'observability', 'src', 'metrics.ts');
const DASHBOARDS = join(REPO_ROOT, 'infrastructure', 'monitoring', 'grafana', 'dashboards');

/**
 * Series names referenced by any alert expression.
 *
 * Suffixes Prometheus adds to a histogram (`_bucket`, `_sum`, `_count`) are stripped:
 * the catalogue declares `starlink_message_send_ack_seconds` and the alert legitimately
 * queries `..._seconds_bucket`. Stripping them is what lets the alert be written the way
 * Prometheus requires while still being checked against the name the code emits.
 */
function seriesInAlerts(): Map<string, string[]> {
  const text = readFileSync(ALERTS, 'utf8');
  const found = new Map<string, string[]>();
  let alert = '(file)';

  for (const line of text.split('\n')) {
    const named = /^\s*-\s*alert:\s*(\S+)/.exec(line);
    if (named !== null) alert = named[1]!;
    // Comments are documentation, not rules. A metric mentioned only in a comment must
    // not be treated as a live reference.
    const code = line.replace(/#.*$/, '');
    for (const match of code.matchAll(/\bstarlink_[a-z0-9_]+/g)) {
      const series = match[0].replace(/_(bucket|sum|count)$/, '');
      found.set(series, [...(found.get(series) ?? []), alert]);
    }
  }
  return found;
}

/** Metric names declared in the catalogue, mapped to their `METRICS.<key>`. */
function catalogue(): Map<string, string> {
  const text = readFileSync(CATALOGUE, 'utf8');
  const byName = new Map<string, string>();
  for (const match of text.matchAll(/(\w+):\s*define\(\s*'([^']+)'/g)) {
    byName.set(match[2]!, match[1]!);
  }
  return byName;
}

/**
 * Series a `# GUARD-WAIVER:` line in `alerts.yml` deliberately exempts.
 *
 * An escape hatch that has to be WRITTEN DOWN, next to the alert, naming what it is
 * waiting on. There is one legitimate reason for an alert to reference a series nothing
 * emits — the value is a business decision nobody has made, and publishing a guess would
 * make the alert fire on fiction (D-05's capacity ceiling is the case). Without a waiver
 * the only options are to weaken the guard for everyone or to invent the number, and both
 * are worse than a declared exception a reviewer can see.
 *
 * Deliberately requires a reason after the metric name: a bare waiver is a silenced alarm
 * with no note saying who silenced it or why.
 */
function waivers(): Set<string> {
  const text = readFileSync(ALERTS, 'utf8');
  const waived = new Set<string>();
  for (const match of text.matchAll(/#\s*GUARD-WAIVER:\s*(starlink_[a-z0-9_]+)\s*(?:—|-|:)\s*(\S[^\n]*)/g)) {
    waived.add(match[1]!);
  }
  return waived;
}

/** `METRICS.<key>` references outside the catalogue itself and outside test files. */
function emittedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of collectSourceFiles()) {
    if (file.path.endsWith('packages/observability/src/metrics.ts')) continue;
    if (file.path.endsWith('.test.ts') || file.path.endsWith('.test.tsx')) continue;
    for (const match of file.content.matchAll(/METRICS\.(\w+)/g)) keys.add(match[1]!);
  }
  return keys;
}

describe('alerts watch series that exist', () => {
  it('finds alerts to check — the guard must not pass over an empty set', () => {
    // A regex that silently matched nothing would make every assertion below vacuous.
    const series = seriesInAlerts();
    expect(series.size).toBeGreaterThan(8);
    expect(catalogue().size).toBeGreaterThan(20);
  });

  it('every series an alert references is a declared metric', () => {
    const declared = catalogue();
    const orphans = [...seriesInAlerts().entries()]
      .filter(([series]) => !declared.has(series))
      .map(([series, alerts]) => `${series} (used by ${alerts.join(', ')})`);

    expect(
      orphans,
      'These alert expressions name series that no metric declares. Either the metric ' +
        'was renamed and the rules file was not updated, or the name is a typo. Both ' +
        'produce an alert that can never fire, which reads exactly like health.\n' +
        orphans.join('\n'),
    ).toEqual([]);
  });

  it('every metric an alert references is emitted somewhere in application code', () => {
    const declared = catalogue();
    const emitted = emittedKeys();
    const waived = waivers();

    const silent = [...seriesInAlerts().entries()]
      .filter(([series]) => declared.has(series))
      .filter(([series]) => !emitted.has(declared.get(series)!))
      .filter(([series]) => !waived.has(series))
      .map(([series, alerts]) => `${series} (would fire for: ${alerts.join(', ')})`);

    expect(
      silent,
      'These alerts watch a metric that NOTHING emits. The rule exists, the series does ' +
        'not, and Prometheus evaluates it over no data for ever — the exact state ' +
        'MessagePageIndexRegression was in from Phase 1 until 2026-08-29. Either emit the ' +
        'metric or delete the alert; a rule nobody can trigger is not coverage.\n' +
        silent.join('\n'),
    ).toEqual([]);
  });

  it('waives only what is written down, with a stated reason', () => {
    /**
     * The waiver mechanism has to be narrow or it becomes the way every awkward alert is
     * silenced. Two properties keep it honest: a waiver must name a real series, and it
     * must be rare enough that a reviewer notices a new one.
     */
    const declared = catalogue();
    const waived = waivers();

    for (const series of waived) {
      expect(declared.has(series), `waiver names an undeclared metric: ${series}`).toBe(true);
    }
    // A ceiling, not a target. If this ever needs raising, the raise is the conversation.
    expect(waived.size).toBeLessThanOrEqual(2);
  });

  it('every metric a dashboard panel graphs is emitted somewhere', () => {
    /**
     * The same rule as the alerts, for the same reason and one step further along.
     *
     * A panel over a series nothing emits draws an empty graph, and an empty graph is
     * read as "nothing is happening" rather than "nothing is measured" — which is exactly
     * the silence Part IV §68 gate 7 asks these dashboards to remove. Gate 7 names
     * "channel errors" and that panel is deliberately ABSENT rather than empty, because
     * no external channel adapter is wired yet; this guard is what keeps that decision
     * honest instead of drifting into a panel somebody adds because the list says so.
     */
    const declared = catalogue();
    const emitted = emittedKeys();
    const waived = waivers();
    const missing: string[] = [];
    // Evidence that the scan below did any work. See the assertions at the end.
    let expressionsScanned = 0;
    const seriesSeen = new Set<string>();

    for (const file of readdirSync(DASHBOARDS).filter((f) => f.endsWith('.json'))) {
      const text = readFileSync(join(DASHBOARDS, file), 'utf8');
      const dashboard = JSON.parse(text) as { panels?: { targets?: { expr?: string }[] }[] };

      // Only panel EXPRESSIONS. A metric named in a panel's prose description is
      // documentation — several describe a series precisely because it is absent.
      const expressions = (dashboard.panels ?? []).flatMap((panel) =>
        (panel.targets ?? []).map((target) => target.expr ?? ''),
      );

      for (const expression of expressions) {
        expressionsScanned += 1;
        for (const match of expression.matchAll(/\bstarlink_[a-z0-9_]+/g)) {
          const series = match[0].replace(/_(bucket|sum|count)$/, '');
          seriesSeen.add(series);
          if (waived.has(series)) continue;
          const key = declared.get(series);
          if (key === undefined || !emitted.has(key)) missing.push(`${file}: ${series}`);
        }
      }
    }

    /**
     * The scan must actually have scanned something.
     *
     * This check ran green for days while proving nothing: the `\b` in the pattern above
     * had been saved as a literal backspace, so it matched no expression in any dashboard
     * and the loop body never executed. An empty `missing` list meant "nothing was
     * examined", and read exactly like "everything is fine".
     */
    expect(
      expressionsScanned,
      'no panel expression was scanned — the dashboards or the pattern are wrong',
    ).toBeGreaterThan(10);
    expect(
      seriesSeen.size,
      'no starlink_ series matched in any panel; this check is not looking at anything',
    ).toBeGreaterThan(5);

    expect(
      [...new Set(missing)],
      'These dashboard panels graph a series nothing emits. An empty graph reads as ' +
        '"nothing is happening", not "nothing is measured".',
    ).toEqual([]);
  });

  it('declares no metric name twice', () => {
    // Two definitions of one name means two call sites writing the same series with
    // different meanings, and whichever ran last wins.
    const text = readFileSync(CATALOGUE, 'utf8');
    const names = [...text.matchAll(/define\(\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(names.length).toBe(new Set(names).size);
  });
});
