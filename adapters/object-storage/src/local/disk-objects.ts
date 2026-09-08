
/**
 * On-disk bytes for the local driver.
 *
 * ## Why this exists
 *
 * `MockObjectStorage` keeps uploads in a `Map`, which is right for a mock and wrong for the
 * driver people actually develop against: every restart of the API emptied every
 * attachment in the product, so a photo sent before lunch was a broken download after it.
 * There is no S3 bucket connected yet, so this is where uploads live.
 *
 * ## The directory IS the key set
 *
 * The base class tracks membership in two in-memory `Set`s — quarantine and clean — and
 * those were lost on restart as surely as the bytes. Rather than persist the sets beside
 * the files and keep two records of one fact in step, the file's LOCATION is its
 * membership: a file under `quarantine/` is quarantined, a file under `clean/` is clean,
 * and promotion is a rename. Nothing can disagree with itself.
 *
 * That also preserves the one rule the base class exists to model — a quarantine key is
 * never served — because `readClean` looks only in the clean directory and a rename is the
 * only way in.
 *
 * ## Keys are validated, not trusted
 *
 * A key reaches this class from the pipeline, but it is one refactor away from reaching it
 * from a request. `safeName` refuses anything but the exact shape the driver issues, so a
 * key containing `..` cannot be turned into a path outside the root. The check costs
 * nothing and removes a whole category of mistake from a file-writing class.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CLEAN_PREFIX, QUARANTINE_PREFIX } from '../mock/mock-object-storage.js';

/**
 * Where the bytes go.
 *
 * `SL_` prefixed with no fallback chain, per rule 13. The default sits under the working
 * directory so a fresh checkout needs no configuration to send an attachment, and it is a
 * dot-directory because it is a cache of dev data rather than part of the repository.
 */
export function localObjectRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SL_STORAGE_LOCAL_DIR ?? join(process.cwd(), '.starlink-objects'));
}

/** `quarantine/<uuid>` and `clean/<uuid>`, and nothing else. */
function safeName(key: string): string | undefined {
  const match = /^(quarantine|clean)\/([0-9a-f-]{36})$/.exec(key);
  if (match === null) return undefined;
  return `${match[1]}__${match[2]}`;
}

export class DiskObjects {
  constructor(private readonly root: string = localObjectRoot()) {
    mkdirSync(this.root, { recursive: true });
  }

  private pathFor(key: string): string | undefined {
    const name = safeName(key);
    return name === undefined ? undefined : join(this.root, name);
  }

  write(key: string, bytes: Uint8Array): boolean {
    const path = this.pathFor(key);
    if (path === undefined) return false;
    writeFileSync(path, bytes);
    return true;
  }

  read(key: string): Uint8Array | undefined {
    const path = this.pathFor(key);
    if (path === undefined || !existsSync(path)) return undefined;
    return new Uint8Array(readFileSync(path));
  }

  has(key: string): boolean {
    const path = this.pathFor(key);
    return path !== undefined && existsSync(path);
  }

  /**
   * Promotion is a rename, so the bytes are never read into memory to move them.
   *
   * Returns the new key, or `undefined`. Deliberately not a `Result`: an `AdapterError`
   * carries a failure class and a correlation id that belong to the ADAPTER, and building
   * one here would be a second, thinner version of the driver's own `fail` helper. The
   * caller already has the real one.
   */
  promote(quarantineKey: string): string | undefined {
    const from = this.pathFor(quarantineKey);
    if (from === undefined || !existsSync(from)) return undefined;
    const cleanKey = `${CLEAN_PREFIX}${quarantineKey.slice(QUARANTINE_PREFIX.length)}`;
    const to = this.pathFor(cleanKey);
    if (to === undefined) return undefined;
    renameSync(from, to);
    return cleanKey;
  }

  remove(key: string): void {
    const path = this.pathFor(key);
    if (path !== undefined) rmSync(path, { force: true });
  }
}
