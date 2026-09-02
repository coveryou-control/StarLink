/**
 * Workspace hygiene guards.
 *
 * These exist because the same class of mistake has now happened three times: a new
 * package is created, everything looks green because the ROOT test run picks its tests
 * up, and `pnpm test` — which runs each package independently, as CI does — fails on
 * it days later.
 *
 * A guard that catches the class is worth more than fixing each instance, so this
 * checks the invariants a new package must satisfy rather than the packages that
 * happen to exist today.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './source-scan.js';

const WORKSPACE_ROOTS = ['packages', 'adapters', 'infrastructure', 'apps'] as const;

interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
}

function workspacePackages(): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const root of WORKSPACE_ROOTS) {
    const rootDir = join(REPO_ROOT, root);
    if (!existsSync(rootDir)) continue;
    for (const entry of readdirSync(rootDir)) {
      const dir = join(rootDir, entry);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      found.push({
        name: `${root}/${entry}`,
        dir,
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>,
      });
    }
  }
  return found;
}

describe('workspace hygiene', () => {
  const packages = workspacePackages();

  it('finds the workspace packages', () => {
    expect(packages.length).toBeGreaterThan(10);
  });

  it('every package with a test script has its own vitest config', () => {
    // Without one, `vitest run` inside the package resolves the ROOT config, whose
    // include globs are repo-root-relative, matches nothing, and exits 1 — while the
    // root run keeps passing and hides it.
    const offenders = packages
      .filter((p) => (p.manifest.scripts as Record<string, string> | undefined)?.test !== undefined)
      .filter((p) => !existsSync(join(p.dir, 'vitest.config.ts')))
      .map((p) => p.name);

    expect(offenders, `packages missing vitest.config.ts:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every package declares the standard task scripts', () => {
    // Turbo runs tasks by name across the workspace; a package missing one is silently
    // skipped rather than reported, so absence looks like success.
    const required = ['build', 'typecheck', 'test', 'lint'];
    const offenders: string[] = [];
    for (const pkg of packages) {
      const scripts = (pkg.manifest.scripts as Record<string, string> | undefined) ?? {};
      for (const script of required) {
        if (scripts[script] === undefined) offenders.push(`${pkg.name}: missing "${script}"`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every package is private, so none can be published by accident', () => {
    const offenders = packages.filter((p) => p.manifest.private !== true).map((p) => p.name);
    expect(offenders).toEqual([]);
  });

  it('every package name is under the @starlink scope', () => {
    const offenders = packages
      .filter((p) => typeof p.manifest.name !== 'string' || !(p.manifest.name as string).startsWith('@starlink/'))
      .map((p) => p.name);
    expect(offenders).toEqual([]);
  });
});
