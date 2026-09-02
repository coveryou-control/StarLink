# STARLINK_ARCHITECTURE_DECISIONS.md

**Status:** PROPOSED — every ADR awaits CTO sign-off. Precedence chain applied throughout: **implementation brief > v2.2 Part IV > v2.1 body**.
**Format:** Context → Decision → Rationale → Consequences. Statuses: PROPOSED / ACCEPTED / SUPERSEDED.

---

## ADR-001 · Primary datastore: PostgreSQL (not MongoDB)

**Context.** v2.1 proposed MongoDB (ADR-03/T-06); Part IV §52 downgraded that to "acceptable if benchmarks pass"; the brief (§32) mandates a fresh evaluation against: message append behaviour, ownership history, transactional outbox, authorization reads, indexes, query patterns, retention, audit, horizontal scale, operational expertise.

**Decision.** PostgreSQL 16+ as the single system-of-record for all StarLink-owned state: conversations, messages, participants, ownership episodes, service-case metadata, queue entries, read/delivery state, notification outbox, transactional outbox, idempotency records, attachment metadata, audit ledger + request context, interim identity projection, configuration entities. JSONB for per-type message payload variation and channel metadata. Logical separation into three schemas (`identity`, `conversation`, `audit`) mirroring the doc's three-database intent, with role-based grants (audit schema write-restricted).

**Rationale — the evaluation the brief required:**

| Criterion | PostgreSQL | MongoDB |
|---|---|---|
| **Transactional outbox (brief §17)** | Message insert + outbox row in one ACID transaction — the pattern's native home. `LISTEN/NOTIFY` wakes the relay with zero polling latency | Requires multi-document transactions on a replica set; workable but operationally heavier, with transaction-size/time limits under load |
| **Atomic claim (brief §44)** | `UPDATE … WHERE state='QUEUED' AND claimed_by IS NULL RETURNING *` — one winner by construction. `SELECT … FOR UPDATE SKIP LOCKED` is the canonical multi-claimer queue pattern for the 100-simultaneous-claims golden test | Single-document conditional update works for the simple case; the claim + ownership-episode + case-update multi-record write needs an explicit transaction anyway (the doc's ADR-03 concedes "stronger multi-row atomicity" to PG) |
| **Ownership episodes / temporal history** | Append-only rows with `effective_from/effective_to`, exclusion constraints available to *prove* no overlapping episodes | Append-only collection; overlap prevention is application discipline only |
| **Authorization reads** | Conversation + participants in one indexed join, or participants denormalised to JSONB if measured hot — both options exist | One document read (its strongest argument) — but this is an optimisation PG can replicate, not a capability gap |
| **Message paging** | Composite index `(conversation_id, created_at DESC, id DESC)` — same bounded-examined property as the doc's measured 301-vs-20,000 result; the property belongs to the index shape, not the engine | Proven on the reference platform |
| **Idempotency records** | Unique constraint + `ON CONFLICT DO NOTHING RETURNING` — exact-once semantics in one statement | Unique index + retry-on-duplicate-key handling |
| **Audit immutability** | `REVOKE UPDATE, DELETE` on the ledger table from the app role — database-enforced, which §31.5 wished for | Application-discipline plus collection permissions |
| **SLA/calendar/config entities** | Relational configuration with FK integrity, versioned rows | Schemaless — the discipline moves into the app (§24.8 conceded) |
| **Search (initial)** | `tsvector` FTS behind SearchProvider — adequate for the V1 corpus, scope-constrained by construction | Text indexes — adequate, weaker ranking |
| **Retention / partitioning** | Native table partitioning by month for messages/audit at the 10M+ horizon; TTL via partition drop | TTL indexes (simpler for request-context expiry — PG uses a partition-drop or pg_cron job) |
| **Operational surface** | One engine runs domain + outbox + queue-of-record + audit. Backup/PITR is one story | Same, but transactions demand replica-set operations from day one of dev |
| **TypeScript ecosystem** | First-class (Drizzle/Prisma/Kysely/pg) | First-class (Mongoose) |

The decisive factors are the brief's own emphases: **outbox consistency, atomic claim, idempotency, and audit-grade history are all multi-row ACID problems.** Every advantage the document claimed for MongoDB (document-shaped reads, per-type variation, append-only audit, proven paging) is reproducible in PostgreSQL with JSONB and composite indexes; the reverse is not true without adopting Mongo transactions everywhere, at which point the simplicity argument is gone.

**Consequences.**

*Denormalisation.* The §24.14 list of nine duplicated fields shrinks, because the queue view is a join rather than nine copies. Exactly what migration 0001 keeps and drops, and why:

| §24.14 field | Kept? | Reason |
|---|---|---|
| Author display name (on `messages`) | **Kept** as `sender_display_name` | Not an optimisation. A message is a historical record and must keep the name in force when it was sent (§24.9) — a join would rewrite history on rename |
| Last activity time (on `conversations`) | **Kept** | Drives the dominant thread-list ordering; recomputing it per row is a correlated subquery on the hottest read |
| Last message preview (on `conversations`) | **Kept** | Same read; avoids fetching a message row per conversation |
| Participant count (on `conversations`) | **Kept** | Avoids a `COUNT(*)` per conversation in list views |
| Case reference (on `conversations`) | **Kept** as `case_id` | Not denormalisation in PostgreSQL — it is the foreign key the 1-case-to-N-conversations relation is built on (§22.4) |
| Internal state (on `conversations`) | **Kept** as `state` | A conversation has its own lifecycle position distinct from its case's; the `conversations_state_presence` constraint enforces that internal conversations have none (D-15) |
| Owner display name | **Dropped** | A join to `identity.principals`; the copy existed only because MongoDB has none |
| Category | **Dropped** | A join to `service_cases`/`categories` |
| Priority | **Dropped** | A join to `service_cases` |

`conversations` additionally carries `customer_ref` and `sensitivity`, which the document does not list. Both are deliberate: `customer_ref` serves the customer's own-history read and the relationship lookup during routing (§24.7 names that index), and `sensitivity` must be evaluated by the authorization decision *before* any case row is loaded, so placing it on the case alone would require reading the case to discover whether the caller may read the case.

Unchanged from the document: SLA state, escalation level and breach flags are **deliberately not denormalised** (§24.14). They change on a clock rather than on an action, and they are the fields that must never reach a customer — keeping them on the case alone means a customer-facing conversation read cannot leak them by accident (§27.16).

*Namespace.* The document's three `starlink_*` databases become three schemas in one `starlink` database (deviation D-1, approved 2026-08-25). This is forced by the engine choice: PostgreSQL cannot commit a transaction across two databases, and both the transactional outbox and FR-AUD-5 ("audit write failure fails the action") require exactly that. The isolation property §35.4 protects is preserved by a startup guard that refuses any database outside the `starlink` namespace and any schema outside the three declared ones — see `infrastructure/database/src/guard.ts`.

*Verification.* A benchmark spike must reproduce the bounded-examined paging property (`EXPLAIN (ANALYZE)` rows-examined ≈ rows-returned) as the doc's Phase-1 gate demanded of MongoDB. Sharding is out of scope (§54's horizon fits comfortably in partitioned single-primary PostgreSQL, with read replicas as the documented next step).

**Status:** **ACCEPTED** (approved 2026-08-25, overruling T-06/ADR-03). Domain packages depend on repository interfaces, not the engine.

---

## ADR-002 · Monorepo: pnpm workspaces + Turborepo, TypeScript end-to-end

**Decision.** One repository, pnpm workspaces, Turborepo for task orchestration/caching. TypeScript everywhere (T-01 upheld: the security-critical objects are shared *shapes* — `visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE'` declared once in `packages/shared-contracts`). Workspace layout per the brief's §3 target structure (see STARLINK_IMPLEMENTATION_PLAN.md §2 for the exact tree). Boundary enforcement: `eslint-plugin-boundaries` + `dependency-cruiser` in CI — domain packages may not import apps or adapters; adapters may not import each other; `customer-web` may not import from `employee-web` or render internal-note components (verified additionally by bundle inspection, per §19.2 and the Phase-1 technology-validation gate).

**Status:** PROPOSED.

## ADR-003 · Backend: NestJS for `api`, `realtime-gateway`, `workers`

**Decision.** NestJS (T-04 upheld) for all three backend apps. Domain logic lives in framework-light workspace packages; Nest modules wire packages + adapters via DI tokens (interface-token injection is how adapter swapping stays a configuration change). Guards implement layers 1–2 of the §18.4 authorization ladder; the object check (layer 3) lives in domain services; class-based serialisers with explicit allow-lists implement layer 4 (fail-closed: unknown fields dropped, per §27.16).

**Status:** PROPOSED.

## ADR-004 · Frontend: Next.js, two apps, two builds, two hosts

**Decision.** `apps/employee-web` and `apps/customer-web` as separate Next.js apps (stronger than v2.1's route-groups: separate apps make "customer bundle cannot contain employee code" true by construction). Shared `packages/ui-primitives` (headless + Tailwind tokens) carries **no domain components**; the internal-note renderer lives only in employee-web. Customer surface mobile-first, SSR first paint; employee surface app-shell. Session cookies host-scoped per surface (§19.3).

**Status:** PROPOSED.

## ADR-005 · Realtime topology: Socket.IO gateway app + Redis backplane, additive-only events

**Decision.** `apps/realtime-gateway`: Socket.IO over WebSocket, horizontally scalable, `@socket.io/redis-adapter` on a Redis-compatible backplane **from the first customer-facing deployment** (Part IV §52 baseline; the v2.1 "no Redis" position is superseded). Topology: client → LB (WS upgrade, sticky only if transport demands) → gateway nodes → Redis pub/sub ← outbox relay ← PostgreSQL ← stateless API.

Rules (all from §20/§27.13/§53, enforced as tests):
- Authorize at subscribe with the same decision function as HTTP; re-validate session + re-authorize every room on reconnect.
- Sockets are closed server-side on session end/revocation/participant removal (session-version bump publishes a `session.revoked` control event the gateway enforces).
- Events carry `{conversation_id, message_id, seq, version}` — never bodies to unestablished subscribers; internal-note events publish with a kind-check so no customer connection can receive them.
- Per-conversation monotonic `seq` (PG sequence per conversation via a counter column); client applies `seq == last+1`, discards `<=`, re-fetches on gap. No replay buffer.
- Reconnect: exponential backoff + jitter; re-fetch authoritative state on resume.
- Presence: Redis leases with TTL, ephemeral, never authoritative availability (§21.9); presence loss degrades silently (P2 class).

**Status:** PROPOSED.

## ADR-006 · Async job fabric: BullMQ on Redis, fed by a PostgreSQL transactional outbox

> **Phase note (2026-08-28):** the fabric is **not built**. Sweeps are the sanctioned V1-A
> form; the trigger for adopting Redis + BullMQ is at the end of this ADR. Read that
> before assuming a queue exists.

**Decision.** Two-tier async architecture:
1. **Transactional outbox (PG)** — the correctness tier. Every state change that must emit events writes an outbox row in the same transaction (brief §17). An **outbox relay** (in `apps/workers`, singleton via advisory lock, `LISTEN/NOTIFY` + poll fallback) reads committed rows and publishes to (a) the Redis realtime backplane, (b) BullMQ job queues, (c) the `EventPublisher` adapter (CCS event fabric when Remote; local log/topic table when Local).
2. **BullMQ (Redis)** — the throughput tier. Queues: `notifications`, `channel-send`, `attachment-scan`, `search-index`, `ai-jobs`, `webhook-inbound`, `reconcile`, `sla-sweep`, `metrics-projection`, `archive`. At-least-once assumed; every consumer idempotent (dedupe on event/job id against the PG `idempotency_records` table where the side effect is external); bounded retries with exponential backoff; DLQ per queue with replay tooling; queue-depth and oldest-age metrics exported.

Why not Kafka/RabbitMQ: Part IV §52/§67 explicitly requires only a "durable managed async queue/job fabric", names SQS-class/Rabbit-class as examples, and the brief's §61 forbids creating Kafka without measured need. BullMQ rides the Redis already mandated for the backplane, is native to the NestJS ecosystem, and the **outbox in PG is what carries the durability guarantee** — Redis loss delays jobs, never loses facts (rows re-publish on relay recovery). If a managed cloud queue is later preferred, only the relay's publish target and worker transport change (an adapter seam, `adapters/event-bus`).

**Status:** PROPOSED. **Amended 2026-08-25 — two corrections from implementation:**

1. **The relay does not live in `apps/workers`.** It lives in `infrastructure/outbox-relay`
   and is *hosted* by whichever process can reach the backplane. With the in-process
   backplane that is `apps/realtime-gateway` — a relay running in a separate process
   would publish into a backplane nobody is listening to, and realtime would be silently
   dead while every test passed. With a shared backplane it moves to a standalone worker.
   Because two different processes may host it, it belongs in neither: the gateway
   importing it from `apps/workers` was an app-to-app dependency the boundary law
   forbids, invisible only because `apps/` was not being cruised. `apps/workers` was
   removed until it has a real process to host; its `start` script already pointed at a
   `main.js` that did not exist.
2. **`FOR UPDATE SKIP LOCKED`, not a singleton advisory lock.** The advisory-lock
   singleton above makes the relay a single point of failure for delivery. Row-level
   claiming lets N relays run concurrently — proven by a test in which two relays deliver
   twelve rows exactly twelve times — and is safe because per-conversation ordering is
   recovered client-side by the sequence-gap rule (FR-RT-4), not by publish order.

**Amended 2026-08-28 — the decision is phase-conditional, and was not written that way.**

Read as it stood, this ADR says BullMQ exists. It does not, and nothing in the repository
recorded that except two source-file comments. The correction is below; **no behaviour
changes**, because the current implementation was already the sanctioned V1-A form of
this decision. What was missing was saying so.

### What Part IV actually requires, and when

§67's supersession table is phase-conditional in both rows, and the condition is the part
this ADR dropped:

> "Redis deferred until after multi-instance trigger." → **"For V1-A developer/local
> single-node it *may be absent*; for V1-B production and 500+ concurrent-user acceptance,
> shared Redis-compatible realtime backplane/counters are *baseline*."**
>
> "No message broker in V1." → **"No heavyweight Kafka requirement. A durable managed
> async queue/job fabric is *baseline* for notifications, integrations, AI/index/media
> tasks and spike absorption."**

§52 assigns the two components distinct jobs: the **shared realtime backplane** is a
"Redis-compatible managed service for Socket.IO adapter/pub-sub, **presence leases**,
ephemeral counters and distributed rate limits"; the **durable async job fabric** is a
"managed queue/broker (e.g., SQS-class/RabbitMQ-class; **choice by ADR**)". This ADR is
that choice. It remains BullMQ-on-Redis.

§33.2 gives the structural trigger precisely — STEP 1, "***THIS IS WHERE REDIS ENTERS***",
conditioned on *"multiple API instances"* — and closes: *"Redis is not in V1 because Step 1
has not happened. **When it does, Redis is required — not optional.**"* §23.9 re-tested that
verdict against the SLA clocks, after-hours queue and business calendar and held it.

### What is built (V1-A form)

**Tier 1 is complete and proven.** The PG transactional outbox, the relay, at-least-once
with idempotent consumers against `conversation.idempotency_records`, bounded retries with
full-jitter backoff, dead-letter with replay tooling, and depth/oldest-age metrics all
exist. Every *guarantee* tier 2 was asked to provide is present.

**Tier 2 is not built.** In its place are nine `setInterval` sweeps hosted in the API
process (`apps/api/src/sweeps.host.ts`). Four map onto queues this ADR names —
`notifications`, `attachment-scan`, `sla-sweep` (whose ADR name is already "sweep") and
`metrics-projection`. `reconcile` and `webhook-inbound` are built as libraries with
nothing hosting them; `channel-send`, `search-index`, `ai-jobs` and `archive` are not due.

**Redis appears in exactly one place: `infrastructure/deployment/compose.yaml`, as a
service connected to nothing.** No client, no dependency, no `SL_REDIS_*` setting.

### What the sweeps do NOT provide, stated so it is not discovered later

1. **Independent scaling.** ADR-020 classifies notifications and attachment processing as
   **P1 queueable**, distinct from **P0 protected**. Running them inside the API process
   means P1 work competes with P0 request handling — the separation exists on paper only.
2. **Multi-instance efficiency.** Every sweep claims conditionally (`FOR UPDATE SKIP
   LOCKED`, `WHERE state = …`), so a second API instance duplicates *work*, never
   *effects*. Safe, and wasteful.
3. **Spike absorption.** §52's "buffers spikes" has no equivalent; a burst lands on the
   database.

None of the three affects correctness. §20.7 is explicit that no event carries state HTTP
cannot also produce — *"NFR-AVL-2 holds because no event carries state that HTTP cannot
also produce"* — so this decision is about scale, cost and experience, never about whether
the product is right.

### The trigger

Redis and the job fabric are adopted at **whichever of these comes first**:

- **A second API or realtime instance holds connections** — §33.2's STEP 1, the structural
  trigger and the only one that can be evaluated today.
- **V1-B production, or the 500+ concurrent acceptance envelope** — §67. Note this cannot
  be evaluated yet: **D-13 (expected customer volume) is NEEDS ESTIMATE**, so 500 is §54's
  engineering envelope rather than a business figure.
- **Before the Phase 12 resilience gate.** §68's gate covers "node, **Redis/backplane,
  queue**, DB, object store, CCS service and provider failure tests behave exactly as
  documented". That gate cannot pass while neither component exists, so the trigger must
  fire *before* Phase 12, not at it.

Adoption is blocked on **N-03** (hosting target: managed Redis?), which is unanswered, and
practically on the fact that the current development machine has no Docker.

### Consequence recorded here because it is otherwise invisible

§52 places **presence leases** in the shared backplane. Until it exists, presence is
readable only inside `apps/realtime-gateway` (`InProcessPresence`), so the API cannot
answer §29.6's "away" question and both of §29.2's "in-app + external **if away**" rows
resolve to in-app only. That is a consequence of this ADR's phase, not a defect in the
notification pipeline, and it is not to be worked around with a `last_seen` column — §52
puts presence in the backplane and §21.9 forbids inferring availability from a socket.

## ADR-025 · Effective periods are stamped by the application clock, at both ends

**Decision.** Wherever a row carries an effective period that authorization reads —
`participants`, `role_assignments`, `delegations`, `temporary_access_grants` — **both**
`effective_from` and `effective_to` are supplied by the application, from the same clock
`decide()` compares against. The database's `DEFAULT now()` must not be relied on for
these columns.

**Why.** `decide()` evaluates "is now inside this period" using the application's clock,
and `endParticipation` already took a caller-supplied `at`. Leaving the START to the
database meant one period had two clocks. On a dev machine running ~57 seconds behind
Neon, a participant added to a conversation was refused it — a 404 on their own thread —
until the skew elapsed, at which point it started working with no trace of why. The same
shape applies to a role grant used immediately after being issued.

This is not an argument for tighter NTP. Synchronised servers shrink the window to
milliseconds; they do not close it, and milliseconds is exactly the gap between "add
Priya to this thread" and Priya's client fetching it. The fix is to stop asking two
clocks the same question.

**Consequence.** Any new dated table must take its timestamps as parameters. A migration
default is acceptable only for columns nothing authorizes against (`created_at`,
`updated_at`). Regression tests live in `packages/conversation-domain/src/conversations.test.ts`.

**Status:** ACCEPTED (found and fixed in implementation, 2026-08-25).

## ADR-026 · A frontend may not import `infrastructure/` or `adapters/`

**Decision.** `.dependency-cruiser.cjs` forbids any edge from `apps/*-web/` to
`infrastructure/` or `adapters/`. The boundary run now cruises `apps/` as well, which it
did not before.

**Why.** A browser bundle that imports a database client ships SQL — and whatever
connection handling sits beside it — to every visitor. Tree-shaking is not a security
boundary: the import edge is the defect whether or not the code survives the build, and
what survives depends on a bundler setting somebody can change. Frontends talk to the API
over HTTP and share **types** only.

Cruising `apps/` also immediately surfaced a real violation that had been invisible: the
realtime gateway importing the outbox relay from `apps/workers` (see ADR-006's amendment).
A rule that is not run is not a rule.

**Status:** ACCEPTED (2026-08-25). Verified to fire against a deliberate probe importing
`infrastructure/database/src/client.ts` from `employee-web`.

**Amended 2026-08-26 — the import rule is necessary but not sufficient.** The customer
bundle shipped the entire employee route map, admin account and role paths included,
without violating any import rule: the client imported the shared-contracts *barrel*,
which re-exports everything. Two additions:

* Employee and customer route tables are separate modules behind separate subpath
  exports (`@starlink/shared-contracts/http/customer`). A barrel accumulates re-exports
  over time and nobody re-checks what a browser ends up with.
* `infrastructure/guards/src/customer-bundle.test.ts` inspects the EMITTED `.next`
  output for employee markers — the "plus emitted-bundle inspection" the dependency law
  always specified and never had. dependency-cruiser reasons about source; this reads
  what actually shipped, and the two answer different questions. The guard also asserts
  its markers appear in the employee bundle, so it cannot pass vacuously.

## ADR-007 · Message write path and idempotency

**Decision.** The canonical write flow (brief §15) implemented as one PG transaction:
`authenticate → authorize (object check) → validate policy/visibility → INSERT message (+ idempotency record ON CONFLICT returns original) → INSERT outbox row → UPDATE conversation last_activity/seq → COMMIT → ack`.
`client_message_id` is unique per (sender, conversation); retries return the original message id and a `duplicate: true` marker. Slow work (notifications, channel sends, AI, indexing) never runs inside this transaction. Ack target p95 < 300 ms excluding delivery (NFR-PRF-2).

**Status:** PROPOSED.

## ADR-008 · Sessions and employee identity: signed version-revocable cookie; interim IAM behind the production interface

**Decision.** Doc ADR-06 pattern upheld: server-issued signed HttpOnly SameSite cookies carrying `principal_id + session_version`; version checked per request (one indexed read); bump-to-revoke effective next request and next socket message. Separate cookie hosts/paths per surface; customer sessions bounded and shorter.

Employee identity resolves **only** through `IdentityAuthorizationClient` / `EmployeeDirectoryProvider` / `HierarchyScopeProvider` / `DelegationProvider` (brief §8). Phase 2 ships `LocalIamAdapter` over PG tables **stamped `authority: 'TEMPORARY_AUTHORITY'`** with the same claim shape the HRMS/Central IAM contract defines (principal_id, employee_id, status, roles, teams, department, branch, manager chain, skills, products, languages, delegations, privileged capabilities, effective dates). Employee exit pathway (session revocation → socket close → no new assignments → owned-conversation surfacing) is implemented against the interface in Phase 2 and is therefore identical when the HRMS adapter replaces the local one (cutover plan: STARLINK_INTEGRATION_CONTRACTS.md §12).

**Status:** PROPOSED.

## ADR-009 · Authorization: contextual policy service, not role-only RBAC

**Decision.** A single decision function `authorize(principal, action, resource, context) → ALLOW | DENY(reason-internal)` in `packages/conversation-domain/authz`, evaluating in order: known-action check (unknown ⇒ DENY) → participation (conversation-scoped grant only) → role×scope assignments (global/department/team/conversation; expiry clock-read) → relationship/ownership → business-object purpose scope → temporary delegation/cover grants (time-boxed, `TemporaryAccessGrant`) → conversation sensitivity class (claims/medical/grievance segmentation) → customer-context restrictions. Deny responses are indistinguishable from not-found (§27.3). Privileged allows (non-participant scoped reads, unmasks, compliance access) emit audit events synchronously — audit failure fails the action for the security-critical set (FR-AUD-5).
TL default team read: **NO** (D-11 recommendation adopted pending business sign-off); Super Admin ≠ PII access; every privileged read audited.

**Status:** PROPOSED.

## ADR-010 · Identifiers: UUIDv7

**Decision.** UUIDv7 for all primary keys (time-ordered → index-friendly, globally unique → safe across adapters/events, no coordination). Conversation ID is immutable for life (brief §4). External channel identities map through `ConversationChannelBinding`, never by reusing provider IDs as PKs. Cursors: base64url of `(created_at, id)` HMAC-signed with `SL_CURSOR_SECRET` (§38 KEEP+IMPROVE).

**Status:** PROPOSED.

## ADR-011 · Data access: Drizzle ORM + SQL migrations

**Decision.** Drizzle ORM (typed schema, transparent SQL, first-class raw-SQL escape hatch needed for `SKIP LOCKED`, partial indexes, exclusion constraints) with `drizzle-kit` generating versioned, reviewable SQL migrations checked into `infrastructure/database/migrations`. Expand → migrate → contract discipline (brief §55); destructive migrations never ship with the app release without a proven rollback. Alternative (Prisma) acceptable; decision is contained to `infrastructure/database` + repository implementations.

**Status:** PROPOSED.

## ADR-012 · Attachments: pre-signed direct transfer, quarantine → scan → promote

**Decision.** Part IV §59 pipeline (supersedes v2.1 §28.4 streaming):
request upload intent (with conversation/purpose) → authorize → issue scoped pre-signed PUT to **quarantine** prefix → client uploads direct → `attachment-scan` job: content-sniff MIME (never trust extension/filename), size verify, malware scan, archive-bomb guard, macro policy, optional DLP/OCR → promote to clean prefix + `AttachmentScanResult` → bind to message (unbound uploads expire; reachable by nobody until bound) → download via short-lived single-object signed GET issued **only after** the full §28.4 check ladder (session, metadata, conversation object check, internal-note-vs-customer check) with the **issuance audited** (satisfying FR-ATT-5's intent). Employee and customer uploads share one pipeline; policy (allow-lists, size, mandatory-scan) is configuration. Dev driver: MinIO; interface: `ObjectStorageProvider`.

**Status:** PROPOSED.

## ADR-013 · Event contracts: versioned, ID-bearing, body-free

**Decision.** Events named `<aggregate>.<event>.v<N>` (catalogue in STARLINK_INTEGRATION_CONTRACTS.md §10). Envelope: `{event_id (UUIDv7), name, version, occurred_at, correlation_id, causation_id, actor_ref, payload}`. Payloads carry IDs + classifications + minimal metadata — **never message bodies or raw PII** onto the enterprise fabric (brief §45). Schema evolution: additive within a version; breaking ⇒ new `vN+1` published alongside `vN` for a deprecation window. Zod schemas in `packages/shared-contracts/events` are the single source; consumers validate on receipt.

**Status:** PROPOSED.

## ADR-014 · Search: `SearchProvider` abstraction, PostgreSQL FTS first

**Decision.** `SearchProvider` interface (scope-first by signature: `search(scope: AuthorizedScope, query, cursor)` — a provider *cannot* be called without a resolved scope). Initial implementation: PG `tsvector` with the scope set as a mandatory join predicate; PII-aware indexing (internal notes flagged; excluded from any future customer search); short terms refused; bounded result sets; cursor paging. OpenSearch-class engine only on the §30.4 triggers, implemented as a second provider with visibility-partitioned indexes and rebuildability.

**Status:** PROPOSED.

## ADR-015 · Audit: local append-only ledger + enterprise publication

**Decision.** Two obligations, one write path: (1) local ledger in the `audit` PG schema — append-only enforced by `REVOKE UPDATE/DELETE` from the app role; request context (IP/UA) in a sibling table with its own retention (partition-dropped; default 180 days, pending D-06); (2) audit-critical events also produce outbox rows publishing to the CCS Event/Audit contract via `EventPublisher` (Part IV §48 — the local store is never the competing enterprise truth). Taxonomy per §31.1/31.2 (privileged reads, ownership changes, participant changes, downloads, searches-with-term, admin actions audited; ordinary internal message sends not). Security-critical actions fail if the ledger write fails.

**Status:** PROPOSED.

## ADR-016 · API: versioned REST, two disjoint operation sets

**Decision.** REST over HTTPS, `/v1/...`. **Two separate route trees** — `/v1/employee/**` and `/v1/customer/**` — with disjoint controllers, serialisers, and OpenAPI documents; the customer set is exactly the §25.3 list (small, enumerable, reviewable) extended with intake/category endpoints. An operation with no declared permission annotation fails CI (fail-closed, §25.4). Uniform error body for deny/not-found. Idempotency keys on message send, claim, and intake. Webhooks live on `apps/api` under `/v1/webhooks/**` with signature verification, or split to a dedicated process if D-01 lands on WhatsApp (§37.2 contingency).

**Status:** PROPOSED.

## ADR-017 · Configuration: `SL_`-prefixed env, schema-validated, fail-closed startup

**Decision.** All settings `SL_*`, one prefix, no fallback chain (§35.1). Zod-validated at boot; production refuses to start on shipped defaults, short secrets, or non-`starlink` schema names; all problems reported together. Business configuration (categories, calendars, SLA targets, capacity weights, reopen window, attachment policy, queue thresholds) lives in **database configuration entities** administered via API — never code (brief §57) — versioned and effective-dated so SLA history re-derives (§23.5). `SL_REALTIME_ENABLED=false` must leave the product fully usable (NFR-AVL-2 test hook).

**Status:** PROPOSED.

## ADR-018 · Observability: OpenTelemetry + pino structured JSON

**Decision.** pino JSON logs (fields per brief §39; prohibited-content list enforced by a serializer-redaction layer + a CI log-schema test); OpenTelemetry traces/metrics with `correlation_id` propagated HTTP → outbox → job → audit (brief §38). Metrics catalogue per brief §38 and Part IV §61, including the two named invariant gauges: `inactive_owner_open_conversations` (alert > 0) and `messages_page_rows_examined_ratio` (alert on drift from ~1). Dev stack: Prometheus + Grafana + Loki in compose; production tooling remains a T-18 infrastructure decision.

**Status:** PROPOSED.

## ADR-019 · Customer identity assurance ladder

**Decision.** `CustomerIdentityProvider` yields a session with `assurance: ANONYMOUS | PSEUDONYMOUS | VERIFIED_CUSTOMER | AUTHENTICATED_CUSTOMER`. Every customer-reachable operation declares a **minimum assurance**; intake/category browsing = ANONYMOUS; starting a general conversation = PSEUDONYMOUS; anything touching policy/claim/payment/history = VERIFIED_CUSTOMER+; sensitive artefact download = AUTHENTICATED_CUSTOMER (values configurable per action class). History from before verification is never inherited by a later assurance upgrade on a *different* identity claim (§27.3), and identity-confidence downgrades narrow access (Part IV §49).

**Status:** PROPOSED.

## ADR-020 · Backpressure and degradation classes

**Decision.** Brief §19 adopted verbatim as the load-shedding policy, enforced at the gateway and job fabric:
- **P0 (protected):** message durability, authorization, ownership ops, customer replies, assignment, security events.
- **P1 (queueable):** notifications, attachment processing, search indexing.
- **P2 (sheddable):** typing, presence, AI suggestions, analytics projections.
Admission control per Part IV §51.9: intake always persists (P0) even when agent assignment is deferred; reservation ceilings bound in-flight assignments; customers get honest queued acknowledgements, never fabricated wait times.

**Status:** PROPOSED.

## ADR-021 · Message visibility is schema, not styling

**Decision.** `visibility ∈ {INTERNAL, CUSTOMER_VISIBLE}` is a non-null column set at write time; if the composer cannot establish it, **the send fails** (BR-27). Customer route tree queries carry `WHERE visibility = 'CUSTOMER_VISIBLE'` at the repository layer (not the controller); customer serialisers are allow-lists; channel adapters reject any outbound message whose class is not explicitly customer-deliverable (Part IV §58); the realtime publisher kind-checks before fan-out. Four independent layers; a property test fuzzes all customer paths for INTERNAL leakage (golden test).

**Status:** PROPOSED.

## ADR-022 · Feature flags

**Decision.** DB-backed flag entity (`packages/shared-contracts/flags`) with per-team/channel/tenant canary targeting, cached with short TTL + pub/sub invalidation. Guarded features per brief §56 (customer pilot, AI replies/summaries, WhatsApp, customer uploads, voice notes, auto-routing, new categories). **No flag may bypass an authorization, consent, or visibility invariant** — flags gate feature exposure, never security checks (enforced by review checklist + lint rule that flag reads cannot appear inside `authz/`).

**Status:** PROPOSED.

## ADR-023 · Agent capacity model

**Decision.** Configurable weighted capacity units (brief §12): each agent has `capacity_units` (per role/team config); work types consume configured weights (ordinary chat 1, complex grievance 2, claim-with-documents 2, live call ≈ full, AI-assisted less — all seed values marked FAKE/DEV pending business sign-off). Assignment feasibility = available units ≥ work weight, computed by the Work Orchestrator adapter from active reservations + declared agent state (AVAILABLE/BUSY/BREAK/OFFLINE/AFTER_CALL/TRAINING). Reservations are atomic with TTL; expiry returns work to queue (Part IV §55). Never hard-coded "5 chats".

**Status:** PROPOSED.

## ADR-024 · What we are explicitly NOT building (triggers recorded)

Per brief §61 and doc §14.2/§33.5: no Kafka (trigger: multi-consumer enterprise fan-out beyond CCS contract, or outbox relay throughput ceiling), no Kubernetes decision here (T-17 production decision), no dedicated search cluster (triggers §30.4), no microservice decomposition (first expected split is already made: realtime gateway; next candidate only on telemetry), no second Customer Master / Opportunity model / Consent engine / Work Orchestrator / permanent user authority (constitutional; enforced by the adapter pattern and reviewed at every phase gate — Part IV §68 gate 1).
