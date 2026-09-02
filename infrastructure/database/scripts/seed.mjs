/**
 * Placeholder business-configuration seeder.
 *
 * Separate from `migrate.mjs` on purpose, and the separation is not cosmetic:
 *
 *   * **Migrations are schema and are forward-only.** They must run everywhere, including
 *     production, and they are recorded so they run exactly once.
 *   * **Seeds are unratified business values.** They must run in development and must
 *     NEVER run in production, because every row they write is marked
 *     `is_seed_placeholder = true` — a flag whose whole purpose is to say "no human has
 *     approved this". Shipping placeholder categories to a real customer is precisely
 *     what §68 gate 8 exists to prevent.
 *
 * Re-runnable: every statement is `ON CONFLICT DO NOTHING`, so this is safe to run
 * against a database that already has the rows. It deliberately does NOT update existing
 * rows — a lead who has corrected a category in the admin console must not have their
 * correction overwritten by a developer running the seeder.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const seedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');

const connectionString =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

// The §35.4 namespace guard, same as the migrator's. Inlined for the same reason: this
// runs as plain Node against the source tree with no build step.
const databaseName = (() => {
  try {
    return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
})();
if (!/^starlink(_[a-z0-9_]+)?$/.test(databaseName)) {
  console.error(
    `refusing to seed "${databaseName}": StarLink may only open databases in the starlink namespace (§35.4)`,
  );
  process.exit(1);
}

/**
 * Refuse to seed a production or staging environment.
 *
 * Fail closed on an UNSET variable too. "The operator forgot to set SL_ENV" and "this is
 * a developer laptop" are indistinguishable from here, and only one of them is safe —
 * so an explicit `dev` or `test` is required rather than assumed.
 */
const env = process.env.SL_ENV;
if (env !== 'dev' && env !== 'test') {
  console.error(
    `refusing to seed with SL_ENV="${env ?? '(unset)'}": placeholder business values are ` +
      'marked is_seed_placeholder=true, meaning no human has approved them. They must ' +
      'never reach a real customer (§68 gate 8). Set SL_ENV=dev or SL_ENV=test.',
  );
  process.exit(1);
}

const isRemote = (() => {
  try {
    return !['localhost', '127.0.0.1', '::1', ''].includes(new URL(connectionString).hostname);
  } catch {
    return true;
  }
})();

const client = new pg.Client({
  connectionString,
  ...(isRemote ? { ssl: { rejectUnauthorized: true } } : {}),
});
await client.connect();

const files = readdirSync(seedDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of files) {
  const sql = readFileSync(join(seedDir, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`seeded ${file}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`FAILED ${file}: ${error.message}`);
    await client.end();
    process.exit(1);
  }
}

const placeholders = await client.query(`
  SELECT 'categories' AS entity, count(*)::int AS n FROM conversation.categories WHERE is_seed_placeholder
  UNION ALL SELECT 'capacity_policies', count(*)::int FROM conversation.capacity_policies WHERE is_seed_placeholder
  UNION ALL SELECT 'business_calendars', count(*)::int FROM conversation.business_calendars WHERE is_seed_placeholder
  UNION ALL SELECT 'sla_targets', count(*)::int FROM conversation.sla_targets WHERE is_seed_placeholder
`);

console.log('\nplaceholder rows now present (none of these are approved values):');
for (const row of placeholders.rows) console.log(`  ${row.entity}: ${row.n}`);
console.log(
  '\nD-21 (working hours) and D-22 (SLA durations) are the two values the architecture\n' +
    'explicitly refuses to propose. Those rows are a STAND-IN chosen on 2026-08-27 so the\n' +
    'clocks can run before the business answers. The hours are what sir said on\n' +
    '2026-08-25 while answering about a DIFFERENT product, and were retracted at the time.\n' +
    'Nothing here is confirmed, and no holidays are configured at all.\n' +
    'Ask again against StarLink before the pilot — §68 gate 8 is what clears these.',
);

await client.end();
