/**
 * The no-skips gate.
 *
 * TEST_STRATEGY: "A gate that did not run must never report green." The database
 * suites deliberately call `ctx.skip()` when no PostgreSQL is reachable, which is the
 * right behaviour for a developer without a database — and exactly the wrong thing to
 * let pass unnoticed in a verification run.
 *
 * This bit us: a connection-exhaustion problem made eleven search-provider tests skip,
 * and the run still reported "all test tasks passed" with a smaller total that nobody
 * would notice. The count going DOWN is the only signal, and counts are not something
 * people diff.
 *
 * Usage:  node infrastructure/guards/src/no-skips.mjs <json-report...>
 * Exits non-zero, naming every skipped test, if any test did not run.
 *
 * Accepts BOTH report shapes the repository produces — Vitest's and Playwright's. The
 * browser journeys are gates by the same definition (TEST_STRATEGY §1 lists "E2E browser"
 * as a row), and a `test.skip()` there is exactly as quiet as a `ctx.skip()` in a unit
 * suite. Holding them to one standard also means there is one file to keep honest rather
 * than two, which is how the CI copy of this check drifted from it in the first place.
 */
import { readFileSync } from 'node:fs';

const reports = process.argv.slice(2);
if (reports.length === 0) {
  console.error('no-skips: no report files given');
  process.exit(2);
}

/**
 * Anything that is not a pass or a fail is a test that did not run.
 *
 * Written as an ALLOW-list of "actually ran" rather than a deny-list of skip statuses,
 * because the first version of this file checked for `pending`/`todo` and vitest emits
 * `skipped` — so the gate cheerfully reported "none skipped" over a report containing
 * eighty-six of them. A guard that cannot fail is worse than no guard: it is a green
 * light nobody looks behind.
 */
const RAN = new Set(['passed', 'failed']);

/**
 * The same allow-list, in Playwright's vocabulary.
 *
 * `expected` is a pass and `unexpected` is a failure; `flaky` passed only on a retry, which
 * still means it executed. Everything else — `skipped`, and any status a future version
 * introduces — did not run and must be named. Deliberately an allow-list for the reason
 * given above: the deny-list version of this file is the bug it was written to fix.
 */
const PW_RAN = new Set(['expected', 'unexpected', 'flaky']);
const PW_FAILED = new Set(['unexpected']);

const shortPath = (name, fallback) =>
  (name ?? fallback).replace(/.*[/\\](?=(apps|packages|adapters|infrastructure|e2e)[/\\])/, '');

/**
 * Flattens either report into `{ name, status, ran, failed }`.
 *
 * Playwright nests suites arbitrarily deep (file → describe → describe), so the specs are
 * walked recursively rather than assumed to sit one level down; a non-recursive version
 * would silently count zero tests for any spec inside a `describe`, which the total===0
 * check below would catch but only by accident.
 */
function* results(report, path) {
  if (Array.isArray(report.testResults)) {
    for (const file of report.testResults) {
      for (const assertion of file.assertionResults ?? []) {
        const status = assertion.status;
        yield {
          name: `${shortPath(file.name, path)} › ${assertion.fullName ?? assertion.title}`,
          status,
          ran: RAN.has(status),
          failed: status === 'failed',
        };
      }
    }
    return;
  }

  if (Array.isArray(report.suites)) {
    yield* playwrightSuites(report.suites, path, []);
    return;
  }

  console.error(
    `no-skips: ${path} is neither a Vitest report (testResults) nor a Playwright report ` +
      '(suites). A report this gate cannot read is a gate that did not run.',
  );
  process.exit(2);
}

function* playwrightSuites(suites, path, titles) {
  for (const suite of suites) {
    const trail = suite.title === undefined || suite.title === '' ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const status = test.status;
        yield {
          name: `${shortPath(suite.file ?? spec.file, path)} › ${[...trail, spec.title].join(' › ')}`,
          status,
          ran: PW_RAN.has(status),
          failed: PW_FAILED.has(status),
        };
      }
    }
    yield* playwrightSuites(suite.suites ?? [], path, trail);
  }
}

const skipped = [];
const failed = [];
let total = 0;

for (const path of reports) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`no-skips: could not read ${path}: ${error.message}`);
    process.exit(2);
  }

  for (const result of results(report, path)) {
    total += 1;
    if (!result.ran) skipped.push(`${result.name}  [${result.status}]`);
    else if (result.failed) failed.push(result.name);
  }
}

// A report with no tests at all is the quietest failure available: a glob that matched
// nothing looks exactly like a suite with nothing wrong.
if (total === 0) {
  console.error('no-skips: the report contains NO tests. A suite that ran nothing is not green.');
  process.exit(1);
}

if (failed.length > 0) {
  console.error(`\nno-skips: ${failed.length} of ${total} tests FAILED:\n`);
  for (const name of failed.slice(0, 25)) console.error(`  · ${name}`);
  if (failed.length > 25) console.error(`  … and ${failed.length - 25} more`);
}

if (skipped.length > 0) {
  console.error(`\nno-skips: ${skipped.length} of ${total} tests DID NOT RUN:\n`);
  for (const name of skipped.slice(0, 25)) console.error(`  · ${name}`);
  if (skipped.length > 25) console.error(`  … and ${skipped.length - 25} more`);
  console.error(
    '\nA skipped gate proves nothing. Start the database (or point SL_DATABASE_URL at one)\n' +
      'and run again, or state explicitly what is left unproven.\n',
  );
}

if (skipped.length > 0 || failed.length > 0) process.exit(1);

console.log(`no-skips: ${total} tests ran, none skipped, none failed.`);
