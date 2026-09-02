/**
 * Fixture identifiers are not shared between test files.
 *
 * Integration tests here run against ONE development database, so their fixtures live in
 * the same tables. Two files that pick the same principal id are not isolated: one
 * suite's rows become the other's foreign-key parents, and the collision surfaces
 * somewhere else entirely.
 *
 * That is not hypothetical. `apps/api/src/customer-isolation.test.ts` used
 * `018f2c5a-dddd-…-000a` for its agent, which `adapters/employee-directory` already used
 * for a sales employee. The isolation suite gave that principal `service_cases`; the
 * directory suite's cleanup then hit a foreign-key violation, `beforeAll` threw, and
 * EIGHT unrelated tests reported as skipped. Nothing pointed at the real cause, and the
 * failing suite was not the one at fault.
 *
 * The convention is a four-hex-digit BLOCK — `018f2c5a-<block>-7000-8000-…` — owned by
 * exactly one file. This guard enforces the ownership rather than trusting everyone to
 * remember which blocks are taken.
 */
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SEARCH_ROOTS = ['apps', 'packages', 'adapters', 'infrastructure'];
/** `018f2c5a-<block>-…` — the shared prefix these fixtures all use. */
const FIXTURE_ID = /018f2c5a-([0-9a-f]{4})/g;

/**
 * Only files that WRITE TO THE DATABASE can collide.
 *
 * A test backed by an in-memory store may reuse any id it likes — its fixtures exist
 * only inside its own process, and forbidding that would be a rule with no hazard behind
 * it, which is how guards acquire a reputation for noise. The hazard is specifically a
 * shared table, so the check is scoped to files that open a connection.
 */
function touchesDatabase(contents: string): boolean {
  return (
    /from 'pg'/.test(contents) ||
    /@starlink\/database/.test(contents) ||
    /SL_DATABASE_URL/.test(contents)
  );
}

/** This guard names blocks in its own prose; it owns none of them. */
const SELF = 'infrastructure/guards/src/fixture-ids.test.ts';

async function testFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await testFiles(full)));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

describe('database fixture identifiers', () => {
  it('gives each test file its own id block', async () => {
    const files: string[] = [];
    for (const root of SEARCH_ROOTS) files.push(...(await testFiles(join(REPO_ROOT, root))));

    /** block -> the files that use it. */
    const owners = new Map<string, Set<string>>();

    for (const file of files) {
      const name = relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (name === SELF) continue;
      const contents = readFileSync(file, 'utf8');
      if (!touchesDatabase(contents)) continue;
      for (const match of contents.matchAll(FIXTURE_ID)) {
        const block = match[1]!;
        const existing = owners.get(block) ?? new Set<string>();
        existing.add(name);
        owners.set(block, existing);
      }
    }

    const shared = [...owners.entries()]
      .filter(([, usedBy]) => usedBy.size > 1)
      .map(([block, usedBy]) => `018f2c5a-${block} is used by: ${[...usedBy].sort().join(', ')}`);

    expect(
      shared,
      'These files share a fixture id block and will corrupt each other against a shared ' +
        'database. Give each file its own four-hex-digit block.',
    ).toEqual([]);
  });

  it('finds the fixture blocks at all, so the check above is not vacuous', async () => {
    const files: string[] = [];
    for (const root of SEARCH_ROOTS) files.push(...(await testFiles(join(REPO_ROOT, root))));

    const blocks = new Set<string>();
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      if (!touchesDatabase(contents)) continue;
      for (const match of contents.matchAll(FIXTURE_ID)) blocks.add(match[1]!);
    }

    // If the convention or the prefix ever changes, this fails rather than the guard
    // quietly passing over zero matches.
    expect(blocks.size).toBeGreaterThan(5);
  });
});
