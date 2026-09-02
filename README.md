# StarLink

CoverYou's Conversation OS — one place where employees talk to each other and, in a later
stage, to customers, with every message durable, authorized and auditable.

Private to CoverYou. Not open source, not licensed for redistribution.

---

## What is here

| Path              | Holds                                                              |
| ----------------- | ------------------------------------------------------------------ |
| `apps/`           | Runtime processes — `api`, `realtime-gateway`, `employee-web`, `customer-web` |
| `packages/`       | Domain logic. No package here may import an app or an adapter        |
| `adapters/`       | Everything external, behind its final interface                      |
| `infrastructure/` | Database and migrations, deployment, monitoring, load, build guards  |
| `e2e/`            | Playwright journeys — the browser gate                               |
| `docs/`           | Every project document, including the signed architecture            |
| `design/`         | The imported Claude Design reference the UI is built against         |
| `CLAUDE.md`       | Working conventions, and the rules that are not negotiable           |

Dependency direction is `apps → packages + adapters (via DI) → shared-contracts`, and CI
fails the build on a violation. See `pnpm boundaries`.

## Start here

Read [`docs/CURRENT_STATE_AUDIT.md`](docs/CURRENT_STATE_AUDIT.md) first, then
[`docs/STARLINK_IMPLEMENTATION_PLAN.md`](docs/STARLINK_IMPLEMENTATION_PLAN.md). Architecture
decisions are in [`docs/STARLINK_ARCHITECTURE_DECISIONS.md`](docs/STARLINK_ARCHITECTURE_DECISIONS.md),
adapter contracts in [`docs/STARLINK_INTEGRATION_CONTRACTS.md`](docs/STARLINK_INTEGRATION_CONTRACTS.md).

**When documents disagree:** implementation brief > architecture doc Part IV (§47–68) >
architecture doc v2.1 body (§1–46). Part IV supersedes eight v2.1 positions and they are
listed in `docs/CURRENT_STATE_AUDIT.md` §2.1 — following §1–46 literally will be wrong.

## Running it

Requires Node 22 (see `.nvmrc`) and pnpm 10.12.1.

```bash
pnpm install
cp .env.example .env          # then set SL_DATABASE_URL

pnpm dev:up                   # postgres, redis, minio, mailhog, prometheus, grafana
pnpm --filter @starlink/database migrate
pnpm seed:people              # three dev employees to sign in as (HRMS placeholder)

pnpm build                    # required before tests: packages resolve via dist/
```

No Docker, or no administrator rights? `CLAUDE.md` documents a no-installer PostgreSQL
fallback under `infrastructure/deployment/local-postgres.ps1`.

## Gates

`pnpm verify` runs all of them in the order CI does. Individually:

```bash
pnpm lint
pnpm typecheck
pnpm boundaries               # architecture boundary law
pnpm test:verify              # unit + authz matrix + spikes, fails on any SKIP
pnpm test:e2e:verify          # browser journeys, fails on any SKIP
```

**Use `test:verify`, not `test`.** `pnpm test` reports "all tasks passed" over a report
containing skipped tests, which is how a connection-exhaustion problem once hid eleven
unrun tests inside a green run.

## Configuration

Every setting carries the `SL_` prefix and there is **no fallback to another product's
variables** — a fallback chain is how a standalone system acquires an undeclared
dependency. `@starlink/guards` fails the build if one appears. `.env.example` is the
template and is kept equal to the defaults the product is actually tested against.

Secrets never enter the repository. See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and read the thirteen non-negotiable rules in
[CLAUDE.md](CLAUDE.md) before changing anything in `packages/conversation-domain`,
`infrastructure/database` or the authorization path.
