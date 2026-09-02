/**
 * The customer bundle does not CONTAIN employee code (ADR-004, doc §19.2).
 *
 * dependency-cruiser already forbids the import edge, and that is the primary control.
 * This is the second half the plan calls for — "plus emitted-bundle inspection" — and it
 * answers a different question. The boundary law reasons about source; this reads what
 * actually shipped.
 *
 * The distinction matters because the requirement is not "the customer surface hides
 * employee features". Hiding is a runtime decision, and a runtime decision can be
 * reversed by a bug, a flag, or a devtools console. The requirement is that the bytes a
 * customer's browser receives do not include internal-note composers, admin controls or
 * staff vocabulary at all — so there is nothing to reveal.
 *
 * If this fails, the fix is never to obfuscate the string. It is that something
 * internal has crossed into a public bundle.
 */
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CUSTOMER_BUNDLE = join(REPO_ROOT, 'apps', 'customer-web', '.next', 'static');

/**
 * Markers that belong to the employee surface only.
 *
 * Chosen to be things that would only appear if employee code were bundled — route
 * paths, the internal-note vocabulary, and admin operations. Deliberately NOT generic
 * words like "internal", which appear in framework code and would make this guard noisy
 * enough to be disabled.
 */
const EMPLOYEE_MARKERS = [
  '/v1/employee/',
  'Internal note — the customer cannot see this',
  'INTERNAL — NOT VISIBLE TO CUSTOMER',
  'Save internal note',
  'inactive-owner-conversations',
  'admin/roles',
  'admin/accounts',
  'sl_emp_session',
];

async function jsFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await jsFiles(full)));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

describe('customer bundle inspection (ADR-004)', () => {
  it('ships no employee code', async (ctx) => {
    if (!existsSync(CUSTOMER_BUNDLE)) {
      // Say what is unproven rather than passing quietly: this guard is meaningless
      // without a build, and a green tick over an absent bundle is worse than a skip.
      console.warn(
        '  ⚠ UNPROVEN: customer bundle not built. Run `pnpm build` before this guard means anything.',
      );
      ctx.skip();
      return;
    }

    const files = await jsFiles(CUSTOMER_BUNDLE);
    expect(files.length, 'no JavaScript found in the customer bundle').toBeGreaterThan(0);

    const leaks: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const marker of EMPLOYEE_MARKERS) {
        if (contents.includes(marker)) {
          leaks.push(`${marker}  →  ${file.slice(REPO_ROOT.length + 1)}`);
        }
      }
    }

    expect(
      leaks,
      'Employee code reached the customer bundle. The fix is to remove the dependency, ' +
        'never to rename the string.',
    ).toEqual([]);
  });

  it('finds the employee markers in the EMPLOYEE bundle, so the check is not vacuous', async (ctx) => {
    // Without this, a typo in every marker would make the test above pass forever.
    const employeeBundle = join(REPO_ROOT, 'apps', 'employee-web', '.next', 'static');
    if (!existsSync(employeeBundle)) {
      console.warn('  ⚠ UNPROVEN: employee bundle not built; marker validity unchecked.');
      ctx.skip();
      return;
    }

    const files = await jsFiles(employeeBundle);
    const combined = files.map((file) => readFileSync(file, 'utf8')).join('\n');

    const found = EMPLOYEE_MARKERS.filter((marker) => combined.includes(marker));
    expect(
      found.length,
      'None of the employee markers appear in the employee bundle — they are probably ' +
        'stale, which would make the customer-bundle check pass vacuously.',
    ).toBeGreaterThan(0);
  });
});
