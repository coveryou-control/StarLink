/**
 * No source file may contain a raw control character.
 *
 * CLAUDE.md records this hazard from the first time it happened: a literal NUL used as a
 * composite-key separator made `case-sweeps.ts` **invisible to ripgrep**, because a file
 * containing NUL is classified as binary and silently skipped by every content search in
 * the repository. Someone looking for one of its own exported types concluded it did not
 * exist.
 *
 * It happened twice more, and neither was caught by a test:
 *
 *   * `packages/attachments/src/policy.ts` wrote its control-character class as literal
 *     control characters — so the file that sanitises filenames was itself unsearchable.
 *   * `infrastructure/guards/src/alerts-have-producers.test.ts` held a raw **backspace**
 *     where `\b` had been typed. `/<BS>starlink_[a-z0-9_]+/` matches a literal backspace
 *     followed by "starlink_", which no Grafana expression contains — so that guard
 *     scanned every dashboard, found nothing, and passed. It had proved nothing since the
 *     day it was written.
 *
 * That second one is why this guard exists rather than a note in a document. A control
 * character is invisible in every editor and every diff; the damage is silent, and in the
 * backspace case the damage was *to a guard*, which is the failure that hides other
 * failures. Written as `\u0000`, an escape is legible, searchable and diffable.
 *
 * This sentence used to contain the real byte instead of those six characters, which
 * made THIS file binary to ripgrep and therefore invisible to every content search in
 * the repository — while `SELF` below excludes it from its own scan, so the guard could
 * never have caught it. Corrected 2026-08-31.
 *
 * Tab, newline and carriage return are excluded — they are whitespace, not smuggled data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, collectSourceFiles } from './source-scan.js';

/** Everything below 0x20 except tab (9), newline (10) and carriage return (13). */
const isForbidden = (byte: number): boolean =>
  byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;

describe('no raw control characters in source', () => {
  /*
     This file is NOT excluded from its own scan.

     It used to be, on the reasonable-sounding grounds that a file about control characters
     would naturally contain one. It did — a literal NUL in the doc comment above, in the
     very sentence telling the reader to write the escape instead — and the exclusion is
     precisely why nothing noticed for as long as it was there. A guard that cannot see
     itself has a blind spot exactly where the subject matter is densest.

     Nothing here needs the exemption: the comment names the byte by its escape, which is
     six ordinary characters, and that is the practice the guard is asking for.
  */
  const files = collectSourceFiles();

  it('finds source to scan', () => {
    // A guard that silently scans nothing passes forever — which is precisely the bug
    // this file was written in response to.
    expect(files.length).toBeGreaterThan(50);
  });

  it('contains no control character in any scanned file', () => {
    const offenders: string[] = [];

    for (const file of files) {
      /*
         Re-read as bytes: `collectSourceFiles` decodes as UTF-8, and the point here is
         what is actually on disk.

         Joined to REPO_ROOT, not read bare. `file.path` is relative to the repository
         root, and reading it relative to the process working directory happened to work
         from the root run and threw ENOENT under `pnpm --filter @starlink/guards test` —
         a guard that passes in one runner and errors in the other.
      */
      const bytes = readFileSync(join(REPO_ROOT, file.path));
      let line = 1;
      for (const byte of bytes) {
        if (byte === 10) line += 1;
        else if (isForbidden(byte)) {
          offenders.push(`${file.path}:${line} contains 0x${byte.toString(16).padStart(2, '0')}`);
          break;
        }
      }
    }

    expect(
      offenders,
      'A raw control character makes the file invisible to ripgrep and silently changes ' +
        'what a regex matches. Write the escape (\\u0000, \\b) instead:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('would catch the two characters that have actually caused this', () => {
    // Positive control. Without it, a future narrowing of `isForbidden` could disable the
    // whole guard and every run would stay green.
    expect(isForbidden(0x00), 'NUL — made case-sweeps.ts unsearchable').toBe(true);
    expect(isForbidden(0x08), 'backspace — silently emptied a guard regex').toBe(true);
    // And the whitespace that must keep working.
    expect([9, 10, 13].some(isForbidden), 'tab, newline and CR are legitimate').toBe(false);
  });
});
