/**
 * `pnpm lint` must actually lint.
 *
 * Every package carried `"lint": "echo 'lint: configured in Phase 1.1'"`. Turbo ran all
 * thirty-one, every one exited 0, and the run reported **"31 successful"** — a sentence
 * that was quoted as verification evidence in a status report. Nothing had been linted
 * since the repository was created, and there was no `eslint.config.mjs` at all, though
 * the implementation plan lists one in the repository layout and names lint as a Phase 1
 * CI deliverable.
 *
 * This is the same failure the testing posture names for tests — *a gate that did not run
 * must never report green* — and it is worse than having no lint script, because "31
 * successful" actively tells the reader the opposite of the truth.
 *
 * The guard is deliberately about the SHAPE of the script rather than its exact text: any
 * command that cannot fail is a hollow gate, whatever it is spelled.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, SCANNED_ROOTS } from './source-scan.js';

interface Package {
  readonly name: string;
  readonly lint: string | undefined;
}

function packages(): Package[] {
  const found: Package[] = [];
  for (const root of SCANNED_ROOTS) {
    let entries: string[];
    try {
      entries = readdirSync(join(REPO_ROOT, root));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const manifest = join(REPO_ROOT, root, entry, 'package.json');
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        found.push({ name: parsed.name ?? `${root}/${entry}`, lint: parsed.scripts?.lint });
      } catch {
        // Not a package directory.
      }
    }
  }
  return found;
}

/** Commands that always succeed, and therefore prove nothing. */
const CANNOT_FAIL = /^\s*(echo\b|true\b|exit\s+0|:\s*$|node\s+-e\s+["']?\s*["']?\s*$)/;

describe('the lint gate is not hollow', () => {
  const found = packages();

  it('finds the workspace packages', () => {
    expect(found.length).toBeGreaterThan(20);
  });

  it('has no package whose lint script cannot fail', () => {
    const offenders = found
      .filter((p) => p.lint !== undefined && CANNOT_FAIL.test(p.lint))
      .map((p) => `${p.name}: "${p.lint ?? ''}"`);

    expect(
      offenders,
      'These report success without running anything, which is worse than no script:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('has a linter configuration for those scripts to use', () => {
    // A lint script with no config is the other way to be hollow: ESLint would fail to
    // start, and someone would "fix" it by putting the echo back.
    let config = '';
    try {
      config = readFileSync(join(REPO_ROOT, 'eslint.config.mjs'), 'utf8');
    } catch {
      /* reported below */
    }
    expect(config.length, 'eslint.config.mjs is missing or empty').toBeGreaterThan(200);
    expect(config, 'the config declares no rules').toMatch(/rules\s*:/);
  });

  it('recognises a hollow command whatever it is spelled', () => {
    // Positive control for the matcher above.
    for (const hollow of ["echo 'lint: configured in Phase 1.1'", 'true', 'exit 0', 'echo ok']) {
      expect(CANNOT_FAIL.test(hollow), `should be rejected: ${hollow}`).toBe(true);
    }
    for (const real of ['eslint .', 'eslint src --max-warnings 0', 'tsc --noEmit']) {
      expect(CANNOT_FAIL.test(real), `should be accepted: ${real}`).toBe(false);
    }
  });
});
