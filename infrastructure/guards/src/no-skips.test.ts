/**
 * The no-skips gate, exercised against real reports.
 *
 * `no-skips.mjs` is the single point on which every "green" claim in this repository
 * rests, and until now nothing tested it. That is not a hypothetical risk: the CI copy of
 * the same idea shipped comparing `status === 'pending'` against a Vitest report that says
 * `'skipped'`, and it passed review, passed every run, and proved nothing for months.
 *
 * These cases are POSITIVE CONTROLS above all — each one hands the gate a report it must
 * reject. A test that only feeds it clean reports would pass just as happily over a script
 * that returns 0 unconditionally, which is the failure mode being guarded against.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './source-scan.js';

const GATE = join(REPO_ROOT, 'infrastructure', 'guards', 'src', 'no-skips.mjs');

let workspace: string;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'starlink-no-skips-'));
});

interface Verdict {
  readonly code: number;
  readonly output: string;
}

function run(name: string, report: unknown): Verdict {
  const path = join(workspace, `${name}.json`);
  writeFileSync(path, JSON.stringify(report), 'utf8');
  const result = spawnSync(process.execPath, [GATE, path], { encoding: 'utf8' });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** A Vitest JSON report containing one test per given status. */
const vitestReport = (...statuses: string[]) => ({
  testResults: [
    {
      name: 'c:/Starlink/packages/example/src/thing.test.ts',
      assertionResults: statuses.map((status, index) => ({
        status,
        title: `case ${index}`,
        fullName: `a suite > case ${index}`,
      })),
    },
  ],
});

/** A Playwright JSON report, with the tests nested inside a `describe` as they really are. */
const playwrightReport = (...statuses: string[]) => ({
  stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 },
  suites: [
    {
      title: 'conversation-journey.spec.ts',
      file: 'e2e/conversation-journey.spec.ts',
      suites: [
        {
          title: 'the agent journey',
          specs: statuses.map((status, index) => ({
            title: `step ${index}`,
            tests: [{ status, expectedStatus: 'passed' }],
          })),
        },
      ],
    },
  ],
});

describe('the no-skips gate', () => {
  describe('Vitest reports', () => {
    it('passes a report in which everything ran', () => {
      const { code, output } = run('vitest-clean', vitestReport('passed', 'passed'));
      expect(code, output).toBe(0);
      expect(output).toContain('2 tests ran');
    });

    it('FAILS on a skipped test and names it', () => {
      const { code, output } = run('vitest-skipped', vitestReport('passed', 'skipped'));
      expect(code, output).toBe(1);
      expect(output).toContain('DID NOT RUN');
      expect(output).toContain('case 1');
    });

    it('FAILS on the status the first version of this gate missed', () => {
      // `pending` was the status the original deny-list looked for. It must still be
      // caught — the allow-list catches it for free, and this pins that it does.
      const { code } = run('vitest-pending', vitestReport('pending'));
      expect(code).toBe(1);
    });

    it('FAILS on a failing test', () => {
      const { code, output } = run('vitest-failed', vitestReport('passed', 'failed'));
      expect(code, output).toBe(1);
      expect(output).toContain('FAILED');
    });
  });

  describe('Playwright reports', () => {
    it('passes a report in which every journey ran', () => {
      const { code, output } = run('pw-clean', playwrightReport('expected', 'expected'));
      expect(code, output).toBe(0);
      expect(output).toContain('2 tests ran');
    });

    it('FAILS on a skipped journey and names it', () => {
      /**
       * The control that matters most. A `test.skip()` in a browser spec is exactly as
       * quiet as a `ctx.skip()` in a unit suite, and Playwright's own exit code is 0 over
       * a run that skipped everything.
       */
      const { code, output } = run('pw-skipped', playwrightReport('expected', 'skipped'));
      expect(code, output).toBe(1);
      expect(output).toContain('DID NOT RUN');
      expect(output).toContain('step 1');
    });

    it('FAILS on an unexpected result', () => {
      const { code, output } = run('pw-unexpected', playwrightReport('unexpected'));
      expect(code, output).toBe(1);
      expect(output).toContain('FAILED');
    });

    it('counts a test that only passed on retry as having run', () => {
      const { code } = run('pw-flaky', playwrightReport('flaky'));
      expect(code).toBe(0);
    });

    it('finds tests nested inside a describe rather than reporting none', () => {
      // A non-recursive walk would report zero tests here, which reads as "nothing to
      // check" rather than as the parser bug it would be.
      const { output } = run('pw-nested', playwrightReport('expected'));
      expect(output).toContain('1 tests ran');
    });
  });

  describe('reports it cannot trust', () => {
    it('FAILS on a report containing no tests at all', () => {
      const { code, output } = run('empty', { testResults: [] });
      expect(code, output).toBe(1);
      expect(output).toContain('NO tests');
    });

    it('REFUSES a report shape it does not recognise', () => {
      // Exit 2, distinct from a test failure: the gate did not run, which is the one
      // outcome that must never be mistaken for a pass.
      const { code, output } = run('unknown', { results: [] });
      expect(code, output).toBe(2);
      expect(output).toContain('neither a Vitest report');
    });

    it('REFUSES to run with no report at all', () => {
      const result = spawnSync(process.execPath, [GATE], { encoding: 'utf8' });
      expect(result.status).toBe(2);
    });
  });
});
