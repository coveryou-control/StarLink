/**
 * Shared file-walking helper for the repository guards.
 *
 * Scans SOURCE only. Documentation is excluded deliberately: the audit and ADR
 * documents discuss NorthStar and other platforms by name, and must be able to,
 * without tripping a guard that exists to police what the application DOES.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Directories that contain application source or deployable configuration. */
export const SCANNED_ROOTS = ['apps', 'packages', 'adapters', 'infrastructure'] as const;

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.yaml', '.yml', '.sql', '.json']);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

function walk(directory: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (SCANNED_EXTENSIONS.has(extname(entry))) out.push(full);
  }
}

export function collectSourceFiles(): SourceFile[] {
  const paths: string[] = [];
  for (const root of SCANNED_ROOTS) walk(join(REPO_ROOT, root), paths);
  return paths.map((path) => ({
    path: relative(REPO_ROOT, path).replace(/\\/g, '/'),
    content: readFileSync(path, 'utf8'),
  }));
}
