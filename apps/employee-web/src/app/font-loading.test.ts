import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The fonts named by the tokens are the fonts the browser is actually told to fetch.
 *
 * ## The defect this exists to prevent recurring
 *
 * `ds/fonts.css` opened with `@import url('https://fonts.googleapis.com/css2?family=…')`
 * and declared three `--font-family-*` tokens naming Poppins, Inter and Roboto. Every
 * heading, label and message in the product resolved through those tokens. None of the
 * three ever loaded.
 *
 * An `@import` is honoured only when it precedes every other rule in the sheet. That file
 * is inlined at line 53 of `globals.css`, whose line 1 pulls in `emoji-font.css` and its
 * ten `@font-face` declarations — so twelve rules were already parsed by the time the
 * browser reached it, and the spec says to drop it. Browsers do that silently: no console
 * error, no failed request in the network panel, nothing to notice. The product rendered
 * in `system-ui` for as long as the file looked correct, and a rendered heading measured
 * 40px wide in Segoe UI where Poppins would have been another width entirely.
 *
 * Two rules follow, and the second is the one that matters. Forbidding the remote
 * `@import` only stops this exact mistake; asserting that every family the tokens name
 * appears in the layout's stylesheet link stops the general one — a token confidently
 * naming a face nothing anywhere fetches.
 */
describe('brand fonts are actually loaded', () => {
  const here = join(__dirname);
  const layout = readFileSync(join(here, 'layout.tsx'), 'utf8');

  const cssFiles = (dir: string): readonly string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? cssFiles(join(dir, entry.name))
        : entry.name.endsWith('.css')
          ? [join(dir, entry.name)]
          : [],
    );

  it.each(cssFiles(here).map((f) => [f.slice(here.length + 1), f] as const))(
    '%s pulls no stylesheet over the network',
    (_label, file) => {
      /* A remote `@import` in any of these files is discarded the moment the file is not
         first in the bundle, and which file is first is decided by an import list nobody
         reads as load-bearing. The document head is where a network stylesheet belongs. */
      /* Comments stripped first: `fonts.css` documents the import it used to carry, and a
         guard that cannot tell a described mistake from a live one makes the description
         unwritable — which is how the reason for a fix gets deleted a year later. */
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const remote = css.match(/@import\s+url\(\s*['"]?https?:/gi);
      expect(remote).toBe(null);
    },
  );

  it('the layout links a stylesheet for every family the tokens name', () => {
    const fontsCss = readFileSync(join(here, 'ds', 'fonts.css'), 'utf8');

    /* The first family in each stack is the one being asked for; the rest are the
       fallbacks that were silently doing all the work. */
    const named = [...fontsCss.matchAll(/--font-family-[\w-]+:\s*'([^']+)'/g)]
      .map((m) => m[1])
      .filter((family): family is string => family !== undefined);
    expect(named.length).toBeGreaterThan(0);

    const links = [...layout.matchAll(/href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/g)]
      .map((m) => decodeURIComponent(m[1] ?? ''))
      .join(' ');

    for (const family of named) {
      expect(links, `${family} is named by a token but nothing fetches it`).toContain(
        `family=${family}`,
      );
    }
  });

  it('asks for the faces to be usable while they download', () => {
    /* Without `display=swap` the default is `block`: up to three seconds of invisible text
       on every cold load. The families are a brand preference, not a legibility one. */
    expect(layout).toContain('display=swap');
  });
});
