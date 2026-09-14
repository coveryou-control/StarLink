/**
 * The communication auditor account — the only way one can exist.
 *
 * ## Why this is a script and not an endpoint
 *
 * `SUPERADMIN` reads every conversation in the company: internal one-to-ones, private
 * channels, customer threads, attachments, voice notes. If `POST /admin/roles` could issue
 * it, then whoever holds `admin.role.assign` would hold company-wide read as well — one
 * request away, to themselves — and FR-AUTHZ-7's separation would be true of the action list
 * and false of the system. `admin.controller.ts` refuses the role by name for exactly that
 * reason (`OUT_OF_BAND_ROLES`).
 *
 * So it is issued here: against the database, with operator credentials, by somebody who
 * already has production access. That is deliberately less convenient than a form, and the
 * inconvenience is the control.
 *
 * ## There is exactly one
 *
 * The brief asks for one organization-wide account and no self-service way to make another.
 * This refuses to create a second: if a live `SUPERADMIN` grant already exists on a
 * different principal, the script stops and names the holder. Rotating means revoking the
 * old grant first, which is a deliberate act that leaves two ledger entries.
 *
 * ## What it does NOT do
 *
 * It does not invent an authority. The account is written with `authority =
 * 'TEMPORARY_AUTHORITY'` like every other locally-seeded principal, so the directory marks
 * it interim and HRMS remains the authority when it lands (INTEGRATION_CONTRACTS §1 rule 4,
 * and rule 11 — StarLink has no user authority of its own and is not acquiring one here).
 *
 * ## Usage
 *
 *   node infrastructure/deployment/seed-superadmin.mjs --username audit.officer
 *   node infrastructure/deployment/seed-superadmin.mjs --show
 *   node infrastructure/deployment/seed-superadmin.mjs --revoke
 *
 * The password is READ FROM THE ENVIRONMENT (`SL_SUPERADMIN_PASSWORD`), never generated
 * here and never printed. A credential that appears in a terminal appears in a scrollback,
 * a screen recording and a support ticket; this one is meant to go into a password manager
 * before the account exists.
 */
import process from 'node:process';
import pg from 'pg';

import { hashPassword } from '@starlink/security';

const ROLE = 'SUPERADMIN';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const fail = (message) => {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(1);
};

const url = process.env['SL_DATABASE_URL'];
if (url === undefined || url === '') {
  fail('SL_DATABASE_URL is not set. This script writes directly to the database.');
}

const pool = new pg.Pool({
  connectionString: url,
  /* The same inference the application makes: anything that is not loopback gets verified
     TLS. A script that connected in the clear to the database holding every conversation in
     the company would be a worse hole than the one this account is meant to watch. */
  ...(/localhost|127\.0\.0\.1/.test(url) ? {} : { ssl: { rejectUnauthorized: true } }),
});

/** The live holder of the role, if there is one. */
async function currentHolder() {
  const rows = await pool.query(
    `SELECT r.principal_id, p.username, p.display_name
       FROM identity.role_assignments r
       JOIN identity.principals p ON p.principal_id = r.principal_id
      WHERE r.role = $1
        AND r.effective_from <= now()
        AND (r.effective_to IS NULL OR r.effective_to > now())`,
    [ROLE],
  );
  return rows.rows[0];
}

async function show() {
  const holder = await currentHolder();
  if (holder === undefined) {
    process.stdout.write('\n  No communication auditor exists.\n\n');
    return;
  }
  process.stdout.write(
    `\n  Communication auditor: ${holder.display_name} (${holder.username})\n` +
      `  principal: ${holder.principal_id}\n\n`,
  );
}

async function revoke() {
  const holder = await currentHolder();
  if (holder === undefined) fail('There is no communication auditor to revoke.');

  /**
   * Ended, not deleted.
   *
   * `effective_to` rather than `DELETE`, so the ledger's account of what this person could
   * see WHEN they saw it remains reconstructible. Deleting the grant would leave a trail of
   * privileged reads by somebody with no visible reason to have made them.
   */
  await pool.query(
    `UPDATE identity.role_assignments
        SET effective_to = now()
      WHERE role = $1 AND principal_id = $2
        AND (effective_to IS NULL OR effective_to > now())`,
    [ROLE, holder.principal_id],
  );
  process.stdout.write(
    `\n  Revoked. ${holder.display_name} (${holder.username}) is no longer the auditor.\n` +
      '  The grant was ended rather than deleted, so past reads stay explicable.\n\n',
  );
}

async function create() {
  const username = value('username');
  if (username === undefined || !/^[a-z0-9][a-z0-9._-]{2,60}$/.test(username)) {
    fail('Pass --username <name>, lowercase, at least three characters.');
  }

  const password = process.env['SL_SUPERADMIN_PASSWORD'];
  if (password === undefined || password.length < 16) {
    fail(
      'Set SL_SUPERADMIN_PASSWORD to at least 16 characters.\n' +
        '  It is read from the environment and never printed: put it in a password manager\n' +
        '  before running this, not into a terminal somebody can scroll back through.',
    );
  }

  const holder = await currentHolder();
  if (holder !== undefined) {
    fail(
      `A communication auditor already exists: ${holder.display_name} (${holder.username}).\n` +
        '  There is meant to be exactly one. Revoke the current holder first:\n' +
        '    node infrastructure/deployment/seed-superadmin.mjs --revoke',
    );
  }

  const existing = await pool.query(
    `SELECT principal_id FROM identity.principals WHERE username = $1`,
    [username],
  );

  /**
   * A DEDICATED account, never an existing employee's.
   *
   * Adding the role to somebody's ordinary account would mean their everyday session — the
   * one left open on a laptop in a meeting room — carries company-wide read. It also makes
   * the ledger ambiguous: a read by that principal could be the auditor working or the
   * person working, and nothing distinguishes them. The auditor signs in as the auditor.
   */
  if (existing.rowCount > 0) {
    fail(
      `"${username}" already exists as an ordinary account.\n` +
        '  The auditor must be a dedicated account: an everyday session carrying company-wide\n' +
        '  read is a session left open in a meeting room, and the ledger could not tell the\n' +
        '  auditor working from the person working. Choose an unused username.',
    );
  }

  const principalId = crypto.randomUUID();
  const credentialHash = await hashPassword(password);

  await pool.query(
    `INSERT INTO identity.principals
       (principal_id, kind, employee_id, username, display_name, status, department,
        timezone, credential_hash, authority, effective_from)
     VALUES ($1, 'EMPLOYEE', $2, $3, $4, 'ACTIVE', 'Compliance',
             'Asia/Kolkata', $5, 'TEMPORARY_AUTHORITY', now())`,
    [principalId, `AUDIT-0001`, username, 'Communication Auditor', credentialHash],
  );

  await pool.query(
    `INSERT INTO identity.role_assignments
       (assignment_id, principal_id, role, scope_kind, granted_by, effective_from)
     VALUES (gen_random_uuid(), $1, $2, 'GLOBAL', $1, now())`,
    [principalId, ROLE],
  );

  /**
   * The creation is itself in the ledger.
   *
   * Written here rather than left to the application, because the application had no part
   * in it: this ran against the database. An auditor who appeared with no record of being
   * created would be the one gap in a feature whose entire justification is that every
   * exercise of it is recorded.
   */
  await pool.query(
    `INSERT INTO audit.ledger
       (event_id, actor_id, actor_kind, action, target_kind, target_id, outcome,
        reason, correlation_id, detail)
     VALUES (gen_random_uuid(), NULL, 'EMPLOYEE', 'admin.role.assign', 'principal', $1,
             'SUCCEEDED', 'OUT_OF_BAND_SEED', $2, $3::jsonb)`,
    [
      principalId,
      `seed-superadmin-${Date.now()}`,
      JSON.stringify({ role: ROLE, username, scopeKind: 'GLOBAL', issuedBy: 'operator-script' }),
    ],
  );

  process.stdout.write(
    `\n  Communication auditor created.\n\n` +
      `    username   ${username}\n` +
      `    principal  ${principalId}\n` +
      `    role       ${ROLE} (GLOBAL, read-only)\n\n` +
      '  The password was taken from SL_SUPERADMIN_PASSWORD and is not printed.\n' +
      '  This account can read every conversation in the company and change nothing.\n' +
      '  Every read it makes is written to audit.ledger, which it can query and cannot alter.\n\n',
  );
}

try {
  if (flag('show')) await show();
  else if (flag('revoke')) await revoke();
  else await create();
} finally {
  await pool.end();
}
