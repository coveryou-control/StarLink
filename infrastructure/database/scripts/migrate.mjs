/**
 * Migration runner.
 *
 * Versioned, reviewable, forward-only, recorded (brief §55). Expand -> migrate ->
 * contract: a release never ships a destructive change whose rollback is unproven.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const connectionString =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

// §35.4 namespace guard, applied BEFORE the connection is opened. Inlined here rather
// than imported because this script runs as plain Node against the source tree, with
// no build step; the authoritative implementation and its tests live in src/guard.ts.
const databaseName = (() => {
  try {
    return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
})();
if (!/^starlink(_[a-z0-9_]+)?$/.test(databaseName)) {
  console.error(
    `refusing to migrate "${databaseName}": StarLink may only open databases in the starlink namespace (§35.4)`,
  );
  process.exit(1);
}

// TLS for any remote host. A managed provider reached over the public internet
// without it would put schema and seed data on the wire in clear (NFR-SEC-4).
const isRemote = (() => {
  try {
    const u = new URL(connectionString);
    return !['localhost', '127.0.0.1', '::1', ''].includes(u.hostname);
  } catch {
    return true;
  }
})();

const client = new pg.Client({
  connectionString,
  ...(isRemote ? { ssl: { rejectUnauthorized: true } } : {}),
});
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`);

const applied = new Set(
  (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
);

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  // Each migration is one transaction: a partially-applied schema change is the
  // hardest kind of state to reason about during an incident.
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`applied ${file}`);
    count += 1;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`FAILED ${file}: ${error.message}`);
    await client.end();
    process.exit(1);
  }
}

console.log(count === 0 ? 'up to date' : `${count} migration(s) applied`);
await client.end();
