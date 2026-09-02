# StarLink — working conventions

CoverYou's Conversation OS. **Every project document lives in `docs/`.** Read
`docs/CURRENT_STATE_AUDIT.md` first, then `docs/STARLINK_IMPLEMENTATION_PLAN.md`.
Architecture decisions are in `docs/STARLINK_ARCHITECTURE_DECISIONS.md`; adapter contracts
in `docs/STARLINK_INTEGRATION_CONTRACTS.md`; open business questions in
`docs/STARLINK_OPEN_QUESTIONS.md`; the test strategy in `docs/STARLINK_TEST_STRATEGY.md`;
the feature tracker in `docs/STARLINK_FEATURE_STATUS.md`. The signed architecture document
itself (`.docx` and `.pdf`) is there too.

Source comments name these files WITHOUT the `docs/` prefix - the filenames are unique, so
a search finds them, and rewriting several dozen prose references to relocate two folders
would have been a larger change than the tidy-up was worth.

**Precedence when documents disagree:** implementation brief > architecture doc Part IV
(§47–68) > architecture doc v2.1 body (§1–46). Part IV supersedes eight v2.1 positions;
they are listed in `docs/CURRENT_STATE_AUDIT.md` §2.1. Following §1–46 literally will be wrong.

## Commands

```
pnpm install                # link workspace
pnpm dev:up                 # postgres, redis, minio, mailhog, prometheus, grafana
pnpm --filter @starlink/database migrate
pnpm seed:people            # three named dev employees to sign in as (HRMS placeholder)
pnpm build                  # required before tests: packages resolve via dist/
pnpm exec vitest run        # unit + authz matrix + spikes
pnpm boundaries             # architecture boundary law
pnpm --filter @starlink/guards test   # config namespace + platform independence
powershell -File infrastructure/boundary-fixtures/verify-boundaries.ps1   # proves the law fails on violation
```

## Rules that are not negotiable

These come from architecture doc §46 and the brief. They are enforced by tests, not
by review alone. If a change requires breaking one, it is the wrong change.

1. A message is durable before it is delivered. Never the reverse.
2. Authorization is evaluated before content is read, on every path. The object check
   (`decide()` in `packages/conversation-domain/authz`) is the boundary; serialiser
   field-filtering is defence in depth and never the boundary.
3. Participation grants that conversation and nothing else.
4. An unknown permission is denied, never treated as unrestricted.
5. A customer can never see an internal note. If visibility cannot be established,
   the send fails.
6. Exactly one owner per customer conversation — enforced by a database exclusion
   constraint, not by application discipline.
7. A conversation owned by a deactivated account is reassigned, never orphaned. The
   `inactive_owner_open_conversations` metric must read zero.
8. The audit ledger is append-only. Enforced by role grants and a trigger.
9. Realtime is additive: no state exists only in an event; recovery is re-fetch.
10. Never invent a business value (SLA targets, working hours, categories, capacity).
    They are configuration entities awaiting sign-off — see `docs/STARLINK_OPEN_QUESTIONS.md`.
11. No second Customer Master, Opportunity model, Consent engine, Work Orchestrator or
    permanent user authority. Upstream gaps get an adapter behind the final interface.
12. StarLink opens only databases in the `starlink` namespace and only the three
    declared schemas (`identity`, `conversation`, `audit`). Enforced before the first
    connection by `infrastructure/database/src/guard.ts`.
13. Every setting carries the `SL_` prefix, with no fallback to another product's
    variables — a fallback chain is how a standalone system acquires an undeclared
    dependency. Enforced by `@starlink/guards`.

## Structure

`apps/` runtime processes · `packages/` domain logic · `adapters/` everything external ·
`infrastructure/` database, deployment, monitoring, load.

Dependency direction: `apps → packages + adapters(via DI) → shared-contracts`.
Domain packages may not import adapters or apps. Adapters may not import each other.
`customer-web` may not import `employee-web`. CI fails the build on violation.

## Running the database

**Dev database: Neon** (team decision, 2026-08-25). Production remains AWS RDS in an
India region — IRDAI's *Maintenance of Insurance Records* Regulations require policy and
claims records to sit in Indian data centres, and Neon has no India region.

First-time Neon setup, in this order:

1. **Create a database named `starlink`** in the Neon project. Neon's default is
   `neondb`, which the §35.4 namespace guard refuses — that is the guard working, not a
   bug. Do not relax it; it is what keeps StarLink unable to reach another product's data.
2. **Copy the DIRECT connection string, not the pooled one** (the pooled host contains
   `-pooler`). The pooled endpoint is PgBouncer in transaction mode and breaks
   session-level advisory locks and `LISTEN/NOTIFY`, both of which the Phase 3 outbox
   relay uses.
3. Set `SL_DATABASE_URL`, then `pnpm --filter @starlink/database migrate`.

TLS is inferred from the host — any non-loopback host gets a verified TLS connection
automatically, so there is no flag to forget.

**Two things Neon does not solve**, both still open:
- **Redis**, which Phase 3 needs for the realtime backplane. Neon is Postgres only.
- **Test latency.** The integration suite makes dozens of round trips per test
  (20 concurrent sends, 20k-row paging). Point `SL_DATABASE_URL` at a local Postgres
  when running tests and keep Neon for the persistent dev database; the loop stays fast
  and nothing in the code changes.

### Local Postgres (fallback, no Docker required)

The committed development stack is the compose file (`pnpm dev:up`), and that is what
CI uses. **This machine has no Docker and no administrator rights**, so development
currently runs against a fallback: PostgreSQL 16.4 from the no-installer binaries,
started as a normal user process. Control it with:

```
powershell -File infrastructure/deployment/local-postgres.ps1 status | start | stop | psql
```

Everything it uses lives under the session scratchpad — binaries, data directory and
log. Nothing is installed system-wide (no Windows service, no registry entry), so
deleting that directory removes it completely. It does **not** survive a reboot; run
`start` again afterwards. Data is dev-only and disposable.

Gotcha worth knowing: the EDB Windows build needs `msvcp140.dll`, `vcruntime140*.dll`
and the UCRT forwarders next to `pgsql/bin/postgres.exe` when the MSVC runtime is not
installed system-wide. Without them it fails with `0xC0000135` (DLL not found) and no
useful message — and the missing library is reached *transitively* through `icuuc67.dll`,
so the error names nothing helpful.

Either way the connection string is the same, and the namespace guard applies:

```
SL_DATABASE_URL=postgres://starlink:starlink_dev_only@localhost:5432/starlink
pnpm --filter @starlink/database migrate
pnpm exec vitest run infrastructure/database     # expect 19 passed, 0 skipped
```

## Signing in during development

There is no user authority in StarLink and there will not be one (rule 11): employees come
from HRMS through the identity adapter, and `SL_ADAPTER_IAM=local` is the placeholder until
that API exists. The placeholder reads `identity.principals`, so until something writes
rows there nobody can open the product.

`pnpm seed:people` writes three named accounts for that purpose — separate from the browser
suite's fixtures, so running the suite cannot delete them and using them cannot perturb it:

| username        | password               | role      |
| --------------- | ---------------------- | --------- |
| `rishitt.gupta` | `starlink-dev-rishitt` | AGENT     |
| `archit.bali`   | `starlink-dev-archit`  | TEAM_LEAD |
| `rahul`         | `starlink-dev-rahul`   | AGENT     |

They are written with `authority = 'TEMPORARY_AUTHORITY'`, which is what makes the
directory render "· interim" beside each name — INTEGRATION_CONTRACTS §1 rule 4 requires an
interim identity source to be unmistakable for a canonical one. When HRMS lands, delete
them with `pnpm seed:people --remove`; nothing in the application changes, which is the
point of the adapter sitting behind the final interface.

The passwords are in the repository, so the script refuses to run unless `SL_ENV` is
`dev`, `test` or `local`.

## Platform notes (learned the hard way)

**Never write `package.json` with PowerShell `Set-Content -Encoding utf8`** on Windows
PowerShell 5.1 — it emits a UTF-8 BOM, and Node-based resolvers then fail to read the
package. The symptom is bizarre: *every* import in that package, including relative
ones, reports as unresolvable while sibling packages are fine. Use
`[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`
or the editor.

**`pnpm build` before `vitest`** on a fresh checkout: workspace packages resolve through
`dist/`, so an unbuilt dependency fails collection.

**dependency-cruiser** needs `parser: 'tsc'` and `preserveSymlinks: false`; `dist` is
`doNotFollow` rather than `exclude`, because a cross-boundary import resolves to the
target's built entry point and excluding `dist` would hide the very violation the rules
exist to catch.

**Never put a raw control character in a source file** — a literal NUL as a composite-key
separator, for instance. It compiles and it runs, and it makes ripgrep classify the file
as binary, so `Grep` silently skips it: the file becomes invisible to every content
search in the repo, and the next person looking for the symbol it contains concludes it
does not exist. Write the escape (`\u0000`) instead. `case-sweeps.ts` was invisible
this way until a grep for one of its own exported types returned nothing.

## Logging conventions

Redaction is applied centrally in `packages/observability`, not per call site. Two rules
follow from that:

- **Qualify your keys.** Bare `name` is redacted because it is ambiguous — it carries
  provider labels and people's names equally, and no value pattern can tell them apart.
  `providerName`, `teamName`, `queueName` all pass. A person's name always uses
  `displayName` or `customerName`, which never pass.
- **Never log a whole request/response body.** `payload`, `requestBody` and `body` are
  redacted wherever they appear, at any depth.

## Testing posture

A gate that did not run must never report green. The database spikes call `ctx.skip()`
when no PostgreSQL is reachable and print what is consequently unproven. Golden tests are
listed in `docs/STARLINK_TEST_STRATEGY.md` §2.

**`pnpm test:verify` is the real gate.** `pnpm test` reports "all tasks passed" when tests
have *skipped*, which is how a connection-exhaustion problem once hid eleven unrun tests
inside a green run. `test:verify` runs the whole suite serially with a JSON report and
fails if anything skipped or failed, naming each one.

**Test files run one at a time** (`fileParallelism: false`). Eight of the twelve projects
open their own pool against the same managed database, and in parallel they exhaust its
connections — which surfaces not as an error but as a suite that quietly proves less than
it claims.

`fileParallelism` is resolved **once per run, not per project**, so it has to be set in
two places and both are load-bearing: `/vitest.config.ts` covers root and ad-hoc runs,
and each DB package's own config covers `pnpm --filter <pkg> test`, where that file *is*
the root config. Setting it only in a package config protects the filtered run and
silently does nothing for the root one — which is the state this repo was in until
2026-08-27, with only `test:verify`'s `--no-file-parallelism` flag holding the line.
`infrastructure/guards/src/test-serialisation.test.ts` fails the build if any of the
three is removed.

**One vitest workspace**, so the root run and `pnpm --filter <pkg> test` are the same run.
They were not: the root config ignored per-package `setupFiles`, so `employee-web`'s
draft tests failed at the root and passed in the package. A root suite that disagrees
with the package suites teaches people to trust whichever is currently green.

**Clocks.** Anything with an effective period must have BOTH ends stamped by the
application clock, never one by the database's `now()`. This dev machine's clock has run
~1 minute behind Neon; participation stamped by the database was therefore "not yet
effective" to a `decide()` reading the app clock, and a freshly added participant got a
404 on their own conversation until the skew elapsed. Well-synced servers shrink the
window, they do not close it.
