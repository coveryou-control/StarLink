# STARLINK_IMPLEMENTATION_PLAN.md

**Status:** PROPOSED — Phase 0 output. Implementation begins only after this plan, the ADRs, and the contracts are approved and the blocking questions in STARLINK_OPEN_QUESTIONS.md are dispositioned.
**Governing precedence:** implementation brief > v2.2 Part IV > v2.1 body. Definition of done per phase is in §5; the global definition of done is brief §63.

---

## 1. Delivery principles

1. **Phases are gates, not sprints.** A phase exits on evidence (tests passing, invariants proven), per Part IV §68. No phase is skipped to produce visible UI (brief §60).
2. **Adapters before integrations.** Every external dependency is consumed through its production interface with a Mock/Local implementation from the phase where it is first needed; Remote implementations land in Phases 9–11 without domain change.
3. **Business values are never invented.** Seed data is marked FAKE/DEV; SLA targets, calendars, categories, capacity weights are configuration entities awaiting sign-off (open questions register).
4. **Every phase leaves the system deployable** (compose up → working system at that phase's scope).

---

## 2. Repository structure (exact)

```
starlink/
├── package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
├── .dependency-cruiser.cjs  eslint.config.mjs        # boundary law (ADR-002)
├── docs/                                             # these five documents + ADRs move here
├── apps/
│   ├── api/                    # NestJS — REST /v1/employee/** and /v1/customer/**, webhooks
│   ├── realtime-gateway/       # Socket.IO nodes, subscribe-authz, presence/typing
│   ├── workers/                # (Phase 4+) BullMQ consumers, sweeps — see note below
│   ├── employee-web/           # Next.js — inbox, queues, thread, notes, transfer, admin
│   └── customer-web/           # Next.js — widget + chat surface, mobile-first
├── packages/
│   ├── shared-contracts/       # adapter interfaces, event schemas (Zod), DTOs, flags, enums
│   ├── conversation-domain/    # Conversation, Participant, authz decision function, visibility
│   ├── messaging/              # Message, MessageRevision/Reference, idempotency, cursors, read/delivery state
│   ├── service-case/           # ServiceCaseMetadata, state machine, ConversationBusinessLink
│   ├── routing/                # queue entries, ownership episodes, claim/transfer/escalation/cover commands
│   ├── sla/                    # BusinessCalendar, SLATarget, clock computation (read-derived), sweeps
│   ├── presence/               # PresenceSession, TypingSignal (Redis leases, ephemeral)
│   ├── attachments/            # upload intents, scan pipeline states, binding
│   ├── notifications/          # NotificationOutbox/Delivery, dedupe, coalescing, preferences
│   ├── audit/                  # ledger writer, taxonomy, request-context store
│   ├── search/                 # SearchDocument shaping, scope resolution glue
│   ├── ai-assist/              # advisory orchestration, redaction-before-provider, prompt registry
│   └── observability/          # pino config, OTel setup, correlation-id propagation, redaction
├── adapters/
│   ├── iam/  employee-directory/  customer-identity/  customer-context/
│   ├── work-orchestrator/  consent/  notification-provider/  object-storage/
│   ├── search/  ai/  event-bus/  telephony/  whatsapp/  email/
│   └── (each: src/{mock,local,remote}/ + contract-conformance tests)
└── infrastructure/
    ├── database/               # drizzle schema, migrations/, seed/ (FAKE-marked)
    ├── outbox-relay/           # the relay itself — see note below
    ├── redis/  queue/  object-storage/                 # compose fragments + drivers config
    ├── monitoring/             # prometheus, grafana dashboards, loki, alert rules
    ├── deployment/             # Dockerfiles, compose.yaml, compose.load.yaml, env templates
    └── load/                   # k6 scenarios (see TEST_STRATEGY §6)
```

Dependency law (CI-enforced): `apps → packages + adapters(interfaces via DI)`; `adapters → shared-contracts only`; `packages → shared-contracts + observability`; **nothing imports an app; adapters never import each other; customer-web never imports employee-web** (plus emitted-bundle inspection); **no frontend imports `infrastructure/` or `adapters/`** — a browser bundle that pulls in a database client ships SQL and credentials to every visitor, and tree-shaking is not a security boundary.

**Where the outbox relay lives (revised 2026-08-25).** It began in `apps/workers`, and the
gateway imported it — an app-to-app dependency the boundary law forbids, invisible only
because `apps/` was not being cruised. The relay is not domain code (it holds no business
rule, and its tests legitimately need real adapters, so `packages/` is the wrong shelf)
and not app code either: *which process hosts it* is a deployment question that changes
with the backplane. An in-process backplane can only be reached from inside the gateway
process, so the relay runs there today; a shared backplane moves it to a standalone
worker. Code that two different processes may host must not live inside either, so it
sits in `infrastructure/outbox-relay` and `apps/workers` was removed until it has a real
process to host — its `start` script already pointed at a `main.js` that did not exist.

---

## 3. Domain model (entities → package → storage)

All PKs UUIDv7 (ADR-010). PG schemas: `identity`, `conversation`, `audit` (ADR-001).

| Entity (brief §4) | Package | Table / notes |
|---|---|---|
| Conversation | conversation-domain | `conversation.conversations` — immutable id, `type` (10-value enum, brief §5), state, seq counter, customer_ref?, case_id?, last_activity_at, preview |
| ConversationParticipant | conversation-domain | `conversation.participants` — role, added_by/at, effective_from/to, reply_authority, internal_only flag |
| Message | messaging | `conversation.messages` — visibility NOT NULL (ADR-021), sender kind, channel_session_id, JSONB body-by-type, client_message_id, reply_to (same-conversation FK), seq |
| MessageRevision | messaging | `conversation.message_revisions` — append-only correction/tombstone lineage (edits governed, original preserved) |
| MessageReference / ReplyReference | messaging | reply_to + `conversation.message_references` for quotes/links |
| ConversationOwnershipEpisode | routing | `conversation.ownership_episodes` — owner, effective_from/to, reason, assigned_by, source, transfer_reason, prev/next owner; **no-overlap exclusion constraint**; current owner = projection |
| ConversationAssignment | routing | assignment commands + reservation refs |
| ConversationQueueEntry | routing | `conversation.queue_entries` — team, state, priority, created_at; claimed via `FOR UPDATE SKIP LOCKED` |
| ConversationState | conversation-domain/service-case | NEW→QUEUED→ASSIGNED→ACTIVE→WAITING_CUSTOMER/WAITING_INTERNAL→RESOLVED→CLOSED; transfer/escalation are events (K-02) |
| ServiceCaseMetadata | service-case | `conversation.service_cases` — category, sub, priority, owning team, designated employee, escalation level, timestamps, reopen count; 1 case : N conversations (§22.4) |
| ConversationBusinessLink | service-case | `conversation.business_links` — CanonicalRef + relation + effective dates; cache columns TTL-bound |
| CustomerConversationContext | conversation-domain | customer session ↔ conversation binding + assurance at bind time |
| InternalNote | messaging | = Message with visibility INTERNAL (deliberately not a second entity, §24.11) |
| Attachment / AttachmentScanResult | attachments | `conversation.attachments` (+ scan results) — quarantine/clean keys, sniffed MIME, binding state, classification |
| ReadState / DeliveryState | messaging | per principal-conversation (unique) / per message-destination for customer channels |
| PresenceSession / TypingSignal | presence | **Redis only** — never PG, never authoritative (§21.9) |
| NotificationOutbox / NotificationDelivery | notifications | `conversation.notification_outbox` — pending/processing/sent/retrying/dead_letter |
| SLAClock / SLAProjection | sla | computed on read from case timestamps + versioned calendars; partial index on running clocks for the sweep (§24.13) |
| TransferEvent / EscalationEvent | routing | append-only event tables, reason mandatory |
| ConversationAuditEvent | audit | `audit.ledger` (append-only, REVOKE UPDATE/DELETE) + `audit.request_context` (own retention) |
| TemporaryAccessGrant | conversation-domain/authz | scoped, time-boxed, audited grants (cover, compliance, delegation) |
| AIConversationSummary | ai-assist | advisory record: model, promptVersion, confidence, evidence refs |
| ConversationChannelBinding / ExternalChannelDelivery | conversation-domain / messaging | channel sessions with external thread ids, verified level, transport rules; provider delivery states |
| IdempotencyRecord | messaging | `conversation.idempotency_records` — unique (scope, key) → result ref |
| Transactional outbox | shared (infra) | `conversation.outbox` — state, next_attempt_at, event envelope |
| Category / BusinessCalendar / SLATarget / CapacityPolicy / FeatureFlag | service-case, sla, shared-contracts | versioned, effective-dated configuration entities (ADR-017) |
| Principal / RoleAssignment / Team / Delegation (interim) | adapters/iam (local) | `identity.*` — every row `authority='TEMPORARY_AUTHORITY'` |

Indexes: exactly the brief §33 list translated to PG composite/partial indexes, plus the exclusion constraint on ownership episodes and the partial index on running SLA clocks. `EXPLAIN` regression tests keep rows-examined ≈ rows-returned (golden metric).

---

## 4. Phase plan (brief §60 mapped to concrete work)

### Phase 0 — Audit & architecture alignment ✅ (this delivery)
Produces the six documents. Exit: internal consistency confirmed; decision register circulated. **No code.**

### Phase 1 — Repository foundation, domain model, DB, contracts, local adapters
**STATUS: COMPLETE except the DB-dependent gates (2026-08-25).**

Delivered:
- Monorepo, workspace, CI, and the **boundary law — gate (a) PROVEN**
  (`infrastructure/boundary-fixtures/verify-boundaries.ps1` shows the build failing on a
  deliberate declared violation and passing clean).
- `packages/shared-contracts` — every adapter interface, domain primitives, the versioned
  event catalogue (Zod), and the **adapter conformance kit** that holds Mock/Local/Remote
  implementations to one behavioural contract.
- `packages/conversation-domain` — the authorization decision function (28-case matrix,
  including the non-participant regression) and the conversation/case state machine.
- `packages/observability` — structured logging with centralised PII redaction (11 tests),
  correlation-id propagation, and the metric catalogue the alert rules reference.
- `infrastructure/database` — migrations 0001–0002 (31 tables, 49 indexes, the
  ownership-overlap exclusion constraint, DB-enforced audit immutability), Drizzle schema
  bindings, migration runner, and placeholder-marked seed data.
- Adapters with conformance tests: `iam`, `work-orchestrator`, `consent`, `object-storage`,
  `event-bus` (Mock implementations; Local/Remote follow in later phases).
- Compose stack, Prometheus config, and alert rules carrying the two invariant gauges.

- **Repository guards** (`infrastructure/guards`) — the two checks the document says belong
  in the build rather than in a reviewer's goodwill: the `SL_` configuration namespace with
  no fallback chain (§35.1) and platform independence (§36.2 / G-24, static half). Each
  verified to fail on a deliberate violation.
- **Startup namespace guard** (`infrastructure/database/src/guard.ts`) — refuses any
  database outside the `starlink` namespace and any schema outside the three declared
  ones (§35.4, ARCHITECTURAL REQUIREMENT), plus the §35.3 production secret checks,
  reporting every problem at once. Wired into the migrate and seed scripts and the spikes.

**Post-checkpoint fixes (2026-08-25):** F-1 namespace guard implemented and wired; F-2
ADR-001 reconciled with the schema field by field; F-3 foreign-prefix guard; F-6
independence guard. ADR-001 and deviation D-1 **APPROVED**.

**Gates (b), (c), (d) — VERIFIED against real PostgreSQL 16.4 on 2026-08-25.** Both
migrations applied cleanly; all five database-dependent tests pass; the CI no-skip
assertion confirms none was skipped. Measured results:

| Gate | Result |
|---|---|
| (b) message paging | `Index Only Scan` on `messages_page_idx`, **50 rows examined for 50 returned** from a 20,000-message conversation, 0.262 ms, **no sort node**. The document's reference measurement was 301 examined per page with the index and 20,000 without |
| (c) transactional outbox | Message and event commit together; a failure after the message insert leaves **neither** |
| (d) atomic claim | **100 simultaneous claimants → exactly 1 winner, 99 clean `ALREADY_ASSIGNED`**, no deadlock |
| BR-10 ownership | Second overlapping episode **rejected by the exclusion constraint** |
| FR-AUD-1 audit | `UPDATE` and `DELETE` on the ledger **both refused** |

Full suite with the database attached: **97 passed, 0 skipped.**

Deferred to the phase that first needs them (interfaces already frozen): mock adapters for
`customer-identity`, `customer-context`, `employee-directory`, `notification-provider`,
`search`, `ai`, `whatsapp`, `email`, `telephony`.
- Monorepo scaffold + boundary tooling + CI (lint, typecheck, test, dependency-cruiser, bundle-inspection job).
- `shared-contracts` complete: all adapter interfaces (INTEGRATION_CONTRACTS), event schemas, enums.
- `infrastructure/database`: schema + migration 0001 (all §3 tables/indexes), seed (FAKE-marked), compose (PG, Redis, MinIO, mailhog, Prometheus/Grafana/Loki). **One command: `pnpm dev:up`.**
- Mock adapters for every family; Local adapters: iam, object-storage(MinIO), event-bus(PG topic), search(PG FTS skeleton).
- **Validation spikes (gate):** (a) boundary violation fails CI; (b) paging `EXPLAIN` bounded-examined proof; (c) outbox txn + relay + Redis publish round-trip; (d) `SKIP LOCKED` claim under 100 concurrent claimers — one winner.
- Exit: spikes green; compose up gives seeded, observable, empty-domain system.

### Phase 2 — Employee identity/auth, internal 1:1 & groups, durability, read/unread, basic search
**STATUS: COMPLETE (closed 2026-08-31).** Every exit criterion below was re-verified
against the repository on that date, not against this document:

- **Authorization matrix including negative cases** — 111 tests across
  `packages/conversation-domain/src/authz`, `claim-authorization.test.ts` and
  `golden-g20-g21-scoped-reads.test.ts`, green.
- **Deactivation golden test** — `apps/api/src/employee-exit.test.ts`, 8 tests, green.
- **Message durability across an API kill** — `apps/api/src/durability.test.ts`, green.
  Fixed on the same day: it drained the outbox ONCE and asserted its own event was among
  the batch, which fails on any database carrying a backlog from another suite. It now
  drains until its own event appears, bounded. The criterion was always met; the test was
  not isolation-safe, and a gate that fails for an unrelated reason is a gate people learn
  to re-run rather than to trust.

Landed:
- `@starlink/database` is an importable package. The pool is created in exactly one
  place, with the §35.4 namespace guard running *before* it exists and `search_path`
  pinned to the three declared schemas.
- `LocalIamAdapter` — PostgreSQL-backed interim identity, every claim stamped
  `TEMPORARY_AUTHORITY`. Passes **the same conformance suite as the mock**, which is the
  adapter-swappability property demonstrated rather than asserted.
- `packages/security` — HMAC signed-token primitives with purpose binding, the
  `SessionService` whose per-request version check makes revocation real (FR-AUTH-2),
  and the signed compound paging cursor (FR-MSG-3/4).
- Drizzle bindings completed for `team_memberships` and `delegations` (missing from the
  Phase 1 schema; the SQL was correct, the typed layer was not).

- `packages/messaging` — the message write path (ADR-007). Persistence behind ports so
  the invariants are unit-testable without a database: authorization before any write,
  message and outbox row in one transaction, idempotent retry returning the original
  message, no body on the event, internal-note text kept out of the conversation
  preview, reply targets scoped to the same conversation, monotonic per-conversation
  sequence, sender display name frozen at send time.

- `PgMessageStore` / `PgMessageReader` — the PostgreSQL side of the messaging ports,
  with the **same write-path invariants proven against a real database**: rollback
  leaves neither message nor outbox row, a retried idempotency key returns the original,
  visibility is filtered in the query rather than in application code, and **20
  concurrent sends produce a gap-free sequence 1–20** (the `FOR UPDATE` row lock).
  Cursor paging uses a row-value comparison `(created_at, message_id) < ($4, $5)` so the
  keyset stays an index range scan rather than a filter.

- `apps/api` — **the first running service.** NestJS, explicit `@Inject(TOKEN)`
  throughout so adapter swapping stays a configuration change. Edge (correlation id,
  session guard), employee auth, conversations, participants, read state, messages,
  health/readiness, and the audit ledger writing live.
- `packages/security/password` — scrypt credential hashing (memory-hard per §27.12,
  no native dependency), parameters carried in the encoded hash so cost can be raised
  without invalidating existing credentials.
- Conversation domain operations + `PgConversationStore` / `PgConversationReader` /
  `PgReadStateStore`: direct-message idempotency, BR-07 history-exposure
  acknowledgement, BR-08 customer exclusion, BR-09 participation dated rather than
  deleted, and a monotonic read marker.

**Verified against a live server and real PostgreSQL:** uniform auth refusals,
idempotent send over HTTP, internal-note text kept out of the conversation preview,
outbox rows matching messages, and **revocation closing a live session on the very next
request** (FR-AUTH-2) on both read and write paths.

**Two bugs found by end-to-end testing and fixed:**
1. Sending into an *internal* thread mapped to `conversation.reply.customer`, so
   participants were refused in their own conversations. There is no customer in an
   internal thread; a new `conversation.message.send` action now covers it, kept
   distinct from addressing a customer (P-03, D-04a).
2. Refusals returned HTTP 200 with an error body, so a client could not distinguish
   denial from success — an e2e check duly read a refusal as a pass. Refusals now
   carry 404 (the same status for "may not" and "does not exist", per §27.3).

- **Employee exit** (`PgAdminStore` + admin endpoints) — deactivation in one transaction:
  status change, session-version bump revoking access on the next request, and a
  snapshot of every open case the leaver owned (FR-EMP-3). The principal record is kept
  so historical authorship stays attributable (brief §49). Reassignment is deliberately
  NOT decided here — that is a routing decision (Phase 5, ultimately CCS).
  The `inactive_owner_open_conversations` gauge (§32.3, target zero) is exposed and
  verified live going 0 → 1 → 0 across deactivation and reassignment.

- **Employee directory** (`LocalEmployeeDirectory`) — PostgreSQL-backed, TEMPORARY_AUTHORITY
  stamped. `kind = 'EMPLOYEE'` is a predicate in every query, so a customer can never
  appear in the directory by any path (§11.7); visibility scope is applied in SQL rather
  than as a post-filter; short terms refused (FR-SRCH-5).
- **Scoped message search** — migration 0003 adds a generated `tsvector` column and GIN
  index (ADR-014). `packages/search` owns the rules; `PgSearchProvider` resolves the
  readable set in a CTE and constrains the query to it (§30.2), covering both
  participation and current ownership. Audited with the term on every attempt, including
  refusals (FR-SRCH-3); "no matches" distinguished from "could not look" (FR-SRCH-4);
  in-process per-principal rate limiting (§27.5, §14.2).

- **`apps/employee-web`** — the employee surface (Next.js, its own app per ADR-004).
  Sign-in, conversation list, thread view, composer, and colleague directory. Client-side
  rendered behind the session cookie: the API is a separate origin and nothing is proxied,
  so development exercises exactly the CORS and cookie boundaries production will have.
  The composer distinguishes an internal note from a customer reply by **four independent
  signals** — badge text, icon, border style, and the send button's wording — because
  NFR-ACC-3 forbids colour as the only cue, and posting an internal note to a customer is
  the most expensive mistake this surface can invite.
- **Drafts** (`DraftStore`, IndexedDB, 11 tests) — client-only and never sent to the
  server without a deliberate action (UC-C05). Keyed by principal **and** conversation
  **and** visibility: a shared machine must not surface a colleague's unsent text, and a
  half-written internal note must never become the body of a customer reply. Clearing
  the composer deletes the record rather than storing an empty one, and sign-out wipes
  every draft for that principal.

- **Admin ENDPOINTS — accounts and roles.** *(Wording corrected 2026-08-31: this bullet
  previously read "Admin console", which implied a screen. There is none — `apps/employee-web`
  contains `conversations` and `sign-in` and nothing else. These are HTTP endpoints, reachable
  by an authorized caller and covered by tests; configuration is loaded by SQL today. An admin
  surface is not a Phase 2 exit criterion and is deliberately NOT built here.)*
  `GET /admin/accounts` (employees only, by a
  `kind = 'EMPLOYEE'` predicate rather than a post-filter; the credential hash is never
  selected, so it cannot be logged by a later change that spreads the row) and
  grant/revoke of role×scope. Both grant and revoke **bump the holder's session version
  in the same transaction**, so a change applies on their next request rather than at
  their next sign-in — and a revocation that left the old privilege live for twelve hours
  would be a revocation in name only. A revoke **dates** the row; it never deletes it,
  because "who could see this last March" is what an audit asks. A scoped grant carrying
  no scope is refused rather than silently widened to GLOBAL.
- **Conversation-list cursor paging.** The list was `LIMIT`-only, silently truncating at
  50 threads with no way to reach the rest. Now a row-value keyset carrying the
  conversation id as tiebreaker — `last_activity_at` is not unique, and a page boundary
  between two threads that moved in the same millisecond otherwise skips one or repeats
  it. The cursor is signed and bound to the **principal** (a message cursor is bound to
  a conversation), with a distinct purpose string so one cannot be presented as the other.
- **Employee directory endpoint.** The adapter had existed since earlier in Phase 2 and
  was never exposed over HTTP — "the directory is built" was true of the adapter and
  false of the product.
- **employee-web completion:** unread badges (carried by weight and a counted badge, not
  colour), conversation-list paging, message paging with scroll anchoring so loading
  older messages does not yank the reader, and **debounced read marking** (FR-READ-4).
- **Route table as a shared contract** (`shared-contracts/http/employee-routes.ts`).
  Five client paths were wrong at once — a URL is a string and nothing checks it, so the
  symptom is a blank screen. Both sides now import one table, and two tests meet in the
  middle: the API probes every route **unauthenticated** and requires 401 (Nest answers
  404 for a route that does not exist, the guard answers 401 for one that does — an
  authenticated probe cannot tell them apart, because a real refusal is also 404 by
  §27.3), while the client asserts it builds those same paths.

**Exit criteria, all met:**
- authz matrix incl. negative cases ✅ · deactivation golden test ✅
- **message durability proven** ✅ — `apps/api/src/durability.test.ts` spawns the real API,
  sends a message, **SIGKILLs the process** (not SIGTERM: SIGKILL cannot be trapped, so
  there is no shutdown hook and no flush), then asserts the message is in the database
  with its outbox row still PENDING, and that a relay in a *different* process drains and
  publishes it. Rules out publish-then-commit, which would lose the event here silently.

**PHASE 2 COMPLETE (2026-08-25).** **406 tests, 38 files, zero skipped**, all five root
tasks green against Neon, boundaries clean across 216 modules.

> **Correction, twice over.** Phase 2 was declared complete at 214 tests without
> `apps/employee-web` or drafts, and again at 316 without admin accounts/roles,
> conversation-list paging, the directory endpoint, read marking, unread counts, or the
> durability exit test. Both times the backend was checked against itself rather than
> against the written phase definition above. Recorded rather than quietly fixed:
> "complete" has to mean the same thing every time it is written, and the check is the
> phase text, not the test count.

**Environment (2026-08-25):** dev database is **Neon** (`ap-southeast-1`, PostgreSQL
16.15, direct endpoint, database `starlink`) per team decision. Production remains AWS
RDS in an India region for IRDAI residency. **No WSL, Docker, Redis or AWS introduced**
at this stage, per standing instruction.
- Session issuance/verification (versioned cookie), LocalIamAdapter, admin console endpoints (accounts, roles, deactivation with owned-conversation surfacing).
- Conversation create (INTERNAL_DIRECT/INTERNAL_GROUP), participant management (BR-05..09, warn-on-history-expose), message write path (ADR-007), cursor paging, read state (debounced), drafts (IndexedDB, client-only).
- Authorization decision function v1 (participation + role×scope + delegation stubs) + negative tests.
- Audit ledger live (participant changes, admin actions, searches-with-term).
- Employee-web: directory, thread list, thread view, composer.
- Exit: authz matrix tests pass incl. all negative cases; deactivation golden test passes; message durability proven (kill API after commit → message survives, event heals via relay).

### Phase 3 — Realtime: gateway, backplane, presence, typing, reconnect, multi-instance safety
**STATUS: SINGLE-NODE SCOPE COMPLETE (2026-08-25). Multi-instance work deferred to the
Redis decision, by instruction.** Everything that does not require a shared backplane is
built and tested; the exit criteria that genuinely need two instances are listed as
unproven at the end of this section rather than quietly dropped. Landed:
- **Realtime contracts** — `RealtimeBackplane` and `PresenceStore`. Channels are typed
  as authorization units, not free-form topics; events carry identifiers and a sequence,
  never bodies (FR-RT-4).
- **In-process backplane and presence** — reports `authority: 'MOCK'` with an explicit
  "single node only" detail, so a single-node deployment is visible in a health probe
  rather than only in a document. Presence leases expire on the clock.
- **Outbox relay** (`infrastructure/outbox-relay`) — the seam that makes
  persist-before-publish real.
  Verified against Neon: retries with backoff, dead-letters visibly, survives backplane
  failure, and **two concurrent relays deliver 12 rows exactly 12 times**. Uses
  `FOR UPDATE SKIP LOCKED` rather than ADR-006's singleton advisory lock — no single
  point of failure, and safe because per-conversation ordering is recovered client-side
  by the sequence-gap rule rather than by publish order.
- **Realtime gateway** (`apps/realtime-gateway`) — Socket.IO with handshake auth reusing
  the SAME session mechanism as HTTP, subscribe-time authorization calling the SAME
  `decide()` as an HTTP read, per-socket staff-only filtering at fan-out, per-principal
  connection ceilings, periodic session revalidation, and graceful drain. The six
  §20.10 rules are tested independently of the transport (16 tests).
- `PgConversationAuthzReader` — non-locking authorization read, so answering "may this
  person look at this?" no longer takes a row lock.
- `toActorContext` re-homed into `conversation-domain`, so the API and the gateway share
  one claims→actor mapping instead of two that could diverge.

- **Gateway proven over real sockets** (14 socket tests): an unauthenticated or forged
  cookie is refused at the handshake, the per-principal connection ceiling holds, a
  staff-only event is withheld from a customer sharing the same room while staff
  receive it, and revocation closes a live socket.
- **Live cross-service proof**: API writes message + outbox → relay drains → backplane →
  gateway → socket. Verified the event references the created message and that the
  message BODY does not travel over the wire (FR-RT-4).

- **Presence and typing wired into the gateway** (16 socket tests). Presence is a
  server-renewed lease: taken at connect, refreshed on a timer, released only when a
  principal's **last** socket closes (closing one of three tabs must not show a colleague
  as offline), and released wholesale on drain so a rolling deploy does not blank the
  team's presence for a TTL. Typing is the only client-originated message the gateway
  fans out to other people, so it is gated four ways — the payload is parsed rather than
  trusted, the socket must have **actually joined** the conversation (not merely be
  entitled to), the rate is floored per socket, and an INTERNAL signal is withheld from
  customer connections. An unrecognised visibility is dropped rather than defaulted,
  since defaulting would fail open.
- **Client-side sequence-gap handling** (`SequenceTracker`, in `apps/employee-web`,
  14 tests) — `seq == last+1` applies, `<= last` discards, a gap re-fetches the range
  from the API rather than rendering a thread with a hole in it. Classification is pure
  and the watermark only advances on an explicit commit, so a failed render cannot leave
  the client believing it displayed an event the user never saw. Reconnect uses **full**
  jitter, verified by dispersing a 500-socket herd across every octile of the interval.

- **Concurrency bug found and fixed:** `ensureChannelSubscription` was not single-flight.
  Two sockets joining one conversation across the same `await` both found no subscription,
  both created one, and the second **overwrote the first's entry** — discarding that
  socket's membership and leaking its backplane subscription. The victim then received
  nothing at all, while its join had acknowledged `ok: true`. The in-process backplane
  resolves immediately so no sequential test could reach it; the regression test uses a
  backplane with a network's worth of latency, which is the realistic case rather than a
  contrivance, and was confirmed to fail against the old code before being kept.

Running total: **316 tests passing**, boundaries clean across 199 modules.

**Gated on Redis, deferred by instruction, and reported as unproven rather than skipped:**
cross-instance fan-out, the multi-instance golden tests (G-03 reconnect storm,
send-via-A-receive-on-B), distributed rate limiting, and shared presence leases. Presence
is currently per-node: two gateways each see only their own connections, so a colleague on
the other node reads OFFLINE. That is wrong but safe — presence never grants anything
(§21.9) — and single-node development is honest today. **A multi-node deploy needs the
shared store before presence means anything.**
- `realtime-gateway` app: subscribe-time authz, session-version enforcement, room-per-conversation, seq-gap protocol, reconnect (backoff+jitter), graceful drain.
- Redis adapter; **two gateway + two API instances in compose from this phase on** (multi-instance is the tested norm, not a future).
- Presence/typing as Redis leases (P2 class, sheddable).
- Exit: multi-instance golden tests (send via A received on B; Redis restart during chat → degraded then recovered, zero loss; reconnect storm 50%/60s; revoked-session socket closed).

### Phase 4 — Customer web chat, session, category/intent, identity abstraction, isolation
**STATUS: COMPLETE (2026-08-26).** Landed:
- **`adapters/customer-identity` — `LocalOtpIdentity`** (20 tests), TEMPORARY_AUTHORITY,
  replaced by CCS in Phase 10. The OTP mechanics are the real ones rather than a
  placeholder, because a stub's failure modes are the ones that survive: codes are stored
  only as an HMAC, compared in constant time, capped at five attempts **per challenge**,
  single-use, and expiring from the clock. `beginVerification` behaves identically for a
  known and an unknown contact, so it is not a customer-enumeration oracle, and every
  failure renders as one indistinguishable refusal. Hints are a delivery address and
  never evidence — a caller who could raise their own assurance by asserting a policy
  number would have defeated the ladder. Proving control of an *unknown* contact yields
  PSEUDONYMOUS, not VERIFIED_CUSTOMER: real evidence, but not of being a customer.
- **Customer projection allow-list** (`conversation-domain/visibility`, 18 tests) —
  §18.4 layer 4. Every projection names its fields and builds a fresh object: no spread,
  no delete, no omit. A deny-list would silently start publishing the SLA flag Phase 6
  adds; an allow-list silently keeps hiding it, which is the direction the silence should
  point. Internal notes are dropped **entirely**, with no placeholder — a "[hidden note]"
  row tells a customer that staff discussed them and exactly when, which is most of the
  leak (§27.16). Principal ids are never emitted, so staff cannot be correlated across
  conversations, and internal lifecycle states collapse to four customer-facing ones.
- **Fuzzed isolation property tests** (the phase's exit criterion, in part) — 1,000
  randomised rounds planting sentinels in internal fields, including fields absent from
  the declared type, which is how a repository doing `SELECT *` would actually leak.
  Validated by deliberately reverting the projection to a spread: 5 tests fail, the
  fuzzer among them.

- **`/v1/customer/**` route tree** — public category browsing, session-on-contact-detail,
  OTP verify start/complete,
  category browsing, intake, conversation list, message read and send. Reads are scoped
  by the participation JOIN and messages are filtered `visibility = 'CUSTOMER_VISIBLE'`
  **in the query**, with the projection dropping internal notes a second time: the query
  is the boundary (§18.4 layer 3), the projection is the last line (layer 4).
- **Intake persists first and fast** (NFR-PRF-2) — conversation and case created
  unassigned in state NEW, then the opening message goes through the SAME `sendMessage`
  path as any other, so the outbox row, sequence and idempotency behave identically. A
  separate intake write path would be a second place to get durability wrong.
- **Category browsing** reads `conversation.categories` and passes `is_seed_placeholder`
  outward as `provisional`; the widget renders those as "(draft)". The category *values*
  remain D-17/D-18 and are not invented. An unknown category is refused at intake rather
  than defaulted — a default would file the request under something nobody chose.
- **`apps/customer-web`** — mobile-first Next.js widget implementing the confirmed
  journey (2026-08-26): browse topics with **no session at all** → pick one → "to
  continue, please add your details" → OTP → the composer appears. Browsing is public,
  so a visitor who reads the topics and leaves mints no principal and no audit entry —
  §21.5: "a customer who abandons at the category step has disclosed nothing."
  Deliberately **no** persistent drafts: the
  employee surface keeps unsent text in IndexedDB because an agent's machine is their
  own, but a customer's device is often shared and the text may concern a claim or a
  complaint — losing a sentence is the cheaper failure.
- **Route-level isolation tests (11)** against a live API — the other half of the fuzzed
  projection tests, and the half that matters more: a projection can be perfect and the
  route still leak by loading the wrong row.

**Two real defects found while building this surface:**

1. **A cross-customer write hole.** `belongsToActorCustomer` was computed as
   `conversation.customerRef !== undefined` — which asks "does this conversation have *a*
   customer reference?", true of every customer conversation. Any customer principal
   could write into any other customer's thread. Latent only because no customer surface
   existed to exercise it, and invisible to the fuzzed projection tests because the hole
   was in the WRITE path, not the serialiser. Ownership is now live participation — a
   fact we recorded — rather than a customer reference, which is a claim we later
   believed. Reproducing it needs a conversation that HAS a reference, so the regression
   test plants one; verified to fail against the old code.
2. **The customer bundle shipped the employee route map**, admin account and role paths
   included, because the client imported the shared barrel. Route paths are not secrets,
   but internal structure in a public bundle is the thin end of the wedge. The route
   tables are now separate modules behind separate subpath exports, and
   `infrastructure/guards/src/customer-bundle.test.ts` reads the emitted `.next` output —
   the "plus emitted-bundle inspection" the dependency law always called for and never
   had. Its second test confirms the markers DO appear in the employee bundle, so the
   first cannot pass vacuously.

- **Assurance-gating tests (15)** — `assurance-ladder.test.ts` walks every rung against
  every requirement, and `send-message.test.ts` proves the write path carries it. The
  test that matters is **the default**: an operation that declares no requirement gets
  VERIFIED_CUSTOMER, not open access. No route reads policy, claim or payment data yet,
  so there is nothing to gate today and none was invented — but when Phase 10 adds one,
  the author forgetting to think about assurance fails closed rather than open. A ladder
  whose default rung is the ground is not a ladder. Also pinned: assurance never
  substitutes for ownership (the highest rung still cannot reach another customer's
  thread), never buys internal content, and does not apply to employees at all.
- **Intake burst test** — 25 concurrent arrivals, each a fresh session plus an intake.
  All accepted, all fully persisted (conversation, case AND opening message), **none
  assigned**: every case unassigned and in state NEW, which is the evidence that nothing
  waited on routing. Isolation holds under concurrency too — a third customer sees
  neither. Timing is reported (median 3.7s, p95 4.3s against remote Neon) rather than
  asserted against a target: NFR-PRF-2's number is a business commitment, and no
  performance claim is made before its test exists (brief §54). The only enforced bound
  is a loose ceiling that would catch catastrophic regression.

**PHASE 4 COMPLETE (2026-08-26).** **458 tests, none skipped**, all root tasks green,
boundaries clean across 239 modules.

**Verification gate added after the business confirmed the journey.** Intake and send now
require PSEUDONYMOUS — a proved contact detail. The previous behaviour accepted a
conversation from someone who had proved nothing, contradicting §21.5 (identity precedes
routing), ADR-019 ("starting a general conversation = PSEUDONYMOUS") and §27.5 (intake is
an abuse target). One test walks the whole real journey including the OTP, because every
other test short-circuits verification and would otherwise prove the bar only against a
shortcut that skips the step that raises it.

**Carried forward, and stated rather than buried:**
- **D-30 is unresolved** and constrains the product: a returning customer does not see
  conversations from a previous session, because ownership is participation and
  participation is per-session. That is the narrow safe reading, not a decision.
- **Customer realtime authorization — FIXED 2026-08-26.** The gateway refused every
  customer subscribe, including to a conversation they had just created. Two causes, and
  both had to be fixed: `PgConversationAuthzReader` never set `belongsToActorCustomer`,
  and the gateway dropped the session's `assurance` so every customer reached `decide()`
  looking ANONYMOUS. It failed CLOSED, which is why it was invisible — no leak, no error,
  just a surface with no working socket that would have been blamed on Redis later.
  Same shape as the write-path bug in `sendMessage`: ownership derived from the wrong
  thing, in a second place. Now derived from live participation, with the assurance
  carried from the session that opened the socket.

  Worth recording *why* it survived: the gateway's own tests **stub** this reader, so the
  stub supplied the field the real one omitted. A stubbed boundary encodes what you
  believe, and the belief was the bug — `authz-reader.test.ts` now exercises the real
  reader against PostgreSQL (7 tests, 3 of which fail against the old code).

  The customer widget still polls at 8s: cross-instance fan-out remains Redis-gated
  (Phase 3's remainder). But the authorization path is no longer broken underneath it.

**Open decision surfaced (needs a ruling before the customer surface ships):**
`ResourceContext.customerVerifiedAt` is declared and documented — "history created before
this point under a different identity claim is never inherited (§27.3)" — but `decide()`
never reads it. The rule is specified and unenforced. Deciding it properly needs an
answer to: *when an anonymous session later verifies as customer X, what happens to the
conversations it created while anonymous?* Inheriting them lets a session launder its way
into a customer's history; discarding them loses a legitimate customer's chat mid-flow.
This is a security-semantics judgement, not an implementation detail, so it is recorded
rather than guessed. Tracked as **D-30**.

- `customer-web` app + `/v1/customer/**` route tree (allow-list per §25.3+intake), CustomerIdentityProvider (Local OTP), assurance ladder enforcement, ANONYMOUS category browsing before identity (§21.5).
- Intake persists conversation P0-fast; visibility filtering at repository layer; customer serialiser allow-lists.
- Exit: **isolation property tests** (customer can never fetch INTERNAL, other customers, staff structure, case fields, SLA/escalation/priority — fuzzed); assurance-gating tests; intake burst test (accept+persist without assignment wait).

### Phase 5 — Routing, queue, claim, assignment, transfer, cover, escalation, ownership episodes
**STATUS: COMPLETE (2026-08-26)**, with one item deferred to Phase 6 by a real dependency
and one limitation recorded as N-17. 574 tests, none skipped. Landed:

- **The §21.8 tree is reachable.** It existed with twenty passing branch tests and **zero
  callers** — `requestRouting` unconditionally enqueued, so no path through the tree had
  ever run against a database. It is now what the Local orchestrator does: designated
  advisor, availability, fallback ladder, and the "queued and VISIBLY UNANSWERED" branch.
  The decision's `path` is returned verbatim as the outcome's reason, so "why did this go
  to Priya?" is answered by the decision rather than by log archaeology.
- **The tree moved from `packages/routing` into `adapters/work-orchestrator/src/local/`.**
  Not a tidy-up — the boundary law (`adapters-must-not-import-domain`) refused the import,
  and it was right to. This plan scopes the tree to the adapter in its own words, and at
  Phase 10 CCS makes these decisions and the tree is deleted with the adapter that owns
  it. `packages/routing` now holds only the ownership **commands**, which outlive the
  cutover. The law caught the mistake before it shipped, which is what it is for.
- **§21.9 availability, sourced from the database** (`PgAvailabilityReader`, 11 tests).
  Deliberately narrow: it has no field for a socket, a heartbeat or a last-seen time, so
  presence cannot be consulted by accident — "a phone entering a lift is not leave" is
  enforced by the type, not by discipline. Declared absence has no table yet (D-05) and is
  reported `false` rather than guessed; the team calendar is Phase 6 and arrives as an
  argument.
- **The capacity ceiling is enforced inside the assigning transaction** — a
  per-principal advisory lock, the live-weight sum and the hold in one commit
  (`assignFromRouting`). `assessAvailability` answers from facts read a moment earlier,
  and a moment is long enough: **twenty simultaneous assignments against a ceiling of one
  admit exactly one**, and that test was verified to fail (20 of 20 admitted) with the
  lock removed before it was kept. An earlier two-caller version of the same test passed
  *without* the lock and was replaced — two sequential awaits through a pool rarely
  interleave in the window that matters. An unconfigured ceiling means **no** ceiling,
  never zero. Weight comes from configuration, never a hard-coded "5 chats".
- **The sweeps are hosted** (`apps/api/src/sweeps.host.ts`). They had tests and no
  process running them, which makes a sweep a function with a test suite: the failure the
  inactive-owner sweep exists to expose stays invisible for exactly as long as nobody
  notices it is not running. Both now start on bootstrap and stop on shutdown, at
  configured intervals.
- **The =0 alert can actually fire.** `alerts.yml` asked
  `starlink_inactive_owner_open_conversations > 0` against a series **nothing emitted** —
  an alert evaluating over absent data never fires, which is silence indistinguishable
  from health. There is now a metric registry, a `/metrics` scrape endpoint, and the
  sweep publishing the gauge **including when it is zero**; a live test strands a case,
  touches no endpoint, and waits for the scheduled sweep to publish it. A guard test
  asserts every `starlink_*` name in `alerts.yml` is one the code can emit — the drift the
  metric catalogue's own header warns about. Queue depth, oldest-waiting age and
  unassigned conversations are published too; `available_capacity_units` deliberately is
  not, because it would need a ceiling D-05 has not set.

**Exit criteria, all met:**
- G-06 double-claim ✅ · G-07 100-simultaneous-claim ✅ · employee-exit reassignment flow
  ✅ · cover-vs-transfer semantics, designated employee preserved ✅ · Local and Mock both
  green against the one `WorkOrchestratorClient` conformance suite ✅

**Was deferred, now CLOSED (2026-08-26) in Phase 6's first slice:** the adapter had no
caller, because `RoutingContext.businessHoursState` had no source until the business
calendar existed. It does now — see Phase 6 below. `SL_ADAPTER_WORK_ORCHESTRATOR` is
consumed, and conversations are placed by a sweep rather than inside intake.

**Limitation recorded, not hidden — N-17:** the ceiling limits *simultaneous placement*,
not sustained workload. Nothing calls `release()` when work finishes (resolve/close is
still ahead in Phase 6), so a hold lapses on its TTL while the conversation is still
owned. Raising the TTL only moves the cliff; the fix is to end the hold when the work
ends.

### Phase 6 — Service case metadata, SLA, business hours, after-hours, resolve/reopen
**STATUS: IN PROGRESS.** Slice 1 — business calendars, after-hours and routing going live
— landed 2026-08-26. 603 tests, none skipped.

**Landed:**
- **`packages/sla` — the business calendar and the clock** (§23.1, §23.5; 24 tests).
  Versioned, effective-dated, per team, with an EXPLICIT IANA timezone — §23.1 is emphatic
  that it is "never inferred from a server clock", so every wall-clock conversion goes
  through `Intl` in the calendar's own zone and the DST cases are tested against
  `America/New_York` as well as IST. No default hours exist anywhere in the code;
  inventing "10:00–19:00" would be inventing a business fact.
  Two properties are the reason the clock is computed rather than stored, and both are
  tested: **a holiday added retrospectively re-derives history**, and **each calendar
  version applies to its own effective period** rather than the current version being
  applied to last month. Elapsed time is additive across any split, including one that
  lands in the middle of the night.
- **`PgBusinessCalendarReader`** returns a team's whole calendar HISTORY, not the row in
  force today — the plural is what makes retroactive correction work. Malformed
  configuration throws rather than degrading to "closed", because closed is a legitimate
  business state and a silent parse failure would be indistinguishable from a shut desk.
- **Routing went live.** Intake still persists and acknowledges without waiting for
  anything (P-05, NFR-PRF-2); placement is a **sweep over committed state**, so a crash
  between the reply and the placement changes nothing — the next tick finds the same work.
  That same sweep is §23.3's "next business period": it re-asks the calendar every tick,
  so an after-hours conversation is picked up when the team opens with no per-conversation
  timer to miss. Ordering is oldest-first, which is §23.4's whole rule until D-24 answers
  priority bands.
- **An unconfigured team is treated as AFTER_HOURS, and said out loud.** The contract has
  only OPEN/AFTER_HOURS, and we do not know that anyone is rostered — so the honest
  reduction is the one that promises nothing. §23.3's invariant still holds: the work is
  queued, in the queue view, and counted. `starlink_teams_without_calendar` makes the gap
  a number rather than a team that mysteriously never gets work.
- **After-hours golden flow** (a named exit criterion; 5 tests against a live API with the
  Local orchestrator). Persist-first, `after_hours = true`, no clock, and an
  acknowledgement asserted to contain no countdown, ETA or "within N minutes" — §23.2's
  "a false promise at 23:30 is worse than no promise", checked on the response body as a
  whole so that a well-meaning addition trips it.

**Slice 2 — case model, SLA and reopen — landed 2026-08-27.** 677 tests, none skipped.

- **`packages/service-case`** — §21.4's transition table transcribed row for row: who may
  make each move, which require a reason, which notify the customer, which are audited.
  The load-bearing test asserts what is NOT there: `TRANSFERRED`, `ESCALATED`,
  `REASSIGNED`, `COVERED` and `BREACHED` must never appear as states, because §21.4's
  correction to v2.0 only holds if something refuses to let them back in — "if
  `transferred` were a state, every query for open work would have to remember to include
  it, and the first one that forgot would hide a customer." `OPEN_STATES` is derived from
  the table rather than listed, so a state added later joins open work automatically.
- **The customer vocabulary, and a bug it exposed.** `toCustomerState` switched on
  `'AWAITING_CUSTOMER'`; the enum value is `'WAITING_CUSTOMER'`. Every conversation
  waiting on the customer fell through the default and displayed as though we were still
  working on it — **the customer was never told it was their turn** — and the unit test
  asserted the same misspelling, so it passed for weeks. The mapping is now a total
  `Record<ConversationState, …>`, so a new state is a compile error until somebody
  decides what the customer sees, and the tests are driven from the enum rather than a
  hand-written list. `WAITING_INTERNAL` maps to *being looked at*, never *waiting for
  you*: waiting on an underwriter is our delay, and saying otherwise leaves a customer
  believing they had already replied wrongly.
- **The SLA clock, computed on read** (§23.5). Migration 0005 dropped the stored
  deadlines; migration 0006 added `case_state_episodes` — append-only, dated, with the
  same GiST exclusion constraint as ownership — because §24.11's *SLA State* entity needs
  **pause spans** and a single current state cannot say a case was waiting from Tuesday to
  Thursday. Observations are stored; conclusions are derived. `instantAfterWorkingSeconds`
  answers §23.5's "late, and by how much": against a business-hours target a message
  arriving at 18:55 breaches at **10:25 the next morning**, not at 19:25.
- **Retroactive re-derivation flips verdicts, not just numbers.** A 40-minute target reads
  BREACHED at 45 minutes elapsed; declare that day a holiday afterwards and the same
  question returns WARNING at 35 minutes with `breachedAt` gone. Nothing migrated.
- **Warning/breach/escalation** (§23.6), each stage firing once. The record is written
  before the notification and only sent if the insert claimed the row, so two instances
  racing produce one alert. Automatic escalation is gated on D-25's answer — Claims and
  Grievance only — because "automatic everywhere risks escalation becoming noise the leads
  learn to ignore". Delivery is logged rather than sent: §29 makes every external channel
  depend on D-01 and D-12, and a stub that pretended to send would make an undelivered
  warning look delivered.
- **Reopen, both branches** (BR-21/BR-22). Inside the window the same thread revives to
  the same owner — unless that owner has left, because BR-13 forbids a deactivated
  principal owning work and reopening onto one would recreate exactly the unreachable work
  §32.3 targets at zero. Outside it, a new conversation on the same case with the prior
  one linked for staff. The customer is told nothing about which happened (§21.4: "No — it
  simply continues"), and a test greps the response body for the words that would leak it.
- **The employee SLA surface** — `GET /v1/employee/conversations/:id/sla`, computed on
  read, behind the same object check as every other route here. There is deliberately no
  customer equivalent: §22.5 gives the customer "Never" for SLA state and calls it the row
  carrying the most risk.
- **Three metrics that were defined, alerted on and never emitted** now are:
  `starlink_sla_at_risk`, `starlink_sla_breaches_total` and
  `starlink_team_waiting_threshold_seconds` — the last completing
  `CustomerWaitingBeyondStandard`, which had compared the live wait against a series
  nothing produced. Same class of failure as the inactive-owner gauge, found by the
  per-phase definition of done rather than by an alert going off.

**Slice 3 — the resolve/close path — landed 2026-08-29.** 914 tests, none skipped.

This slice exists because Phase 6 had been recorded as having met its exit criteria while
**the product had no way to resolve a conversation at all** (N-34). §21.4's transition
table, `case_state_episodes` with its exclusion constraint, the `conversation.resolve` and
`conversation.reopen` actions, `decideReopen` and the reopen-window closure sweep were all
built and tested — and nothing called `transition()`. The note below, in the previous
version of this section, was the tell: *"Closing N-17 (release-on-close) belongs with the
resolve path, which now exists."* It did not exist. The suite stayed green because the
closure sweep's tests and `reopen-flow.test.ts` both seeded RESOLVED rows with raw SQL, and
a test that manufactures the state it exercises cannot notice that nothing upstream can
produce it.

- **`POST /v1/employee/conversations/:id/resolve` and `…/reopen`**, with `PgCaseStore`
  writing the four rows that must move together in one transaction: the conversation's
  state, the case observation (`resolved_at`, which stops the RESOLUTION clock and is the
  closure sweep's cutoff), the append-only episode, and the capacity hold. Every write is
  conditional on the state the caller decided against, so a concurrent resolve or a
  customer's reply is refused rather than overwritten.
- **BR-19 enforced, not documented.** An outcome is required; a blank one is refused by
  the schema and independently by `transition()`. `TEAM_LEAD` gained `conversation.resolve`
  and `conversation.reopen` because BR-19 says "the owner **or a lead**" and the role table
  did not permit it (N-35) — transcription, on the same footing as the `assign`/`transfer`
  entries beside it.
- **BR-20's second half now reaches the customer.** §22.5's row is *"Resolution timestamp —
  when it was resolved, and the outcome — **Outcome only**"*: the customer sees the outcome
  and never the timestamp. Before this they were told a conversation had ended and never
  what came of it.
- **N-17's Phase 6 dependency is discharged** — the capacity hold is released on resolve.
  The TTL half remains and is D-05's (N-38).
- **Two transition tables became one.** `conversation-domain/src/state-machine.ts` was a
  dead second transcription that DISAGREED with the real one, reachable through a barrel
  export (N-33). Deleted, with a guard that fails the build if it returns.

**Slice 4 — the ARRIVAL half of §21.4 — landed 2026-08-29**, and it is why slice 3 was not
finished when it was declared so.

Golden test G-15, walking a whole conversation end to end, refused to pass. Two defects,
both on the primary customer-service path and both invisible to every existing test:

- **A claimed conversation could not be replied to (N-43).** `claimConversation` opened the
  ownership episode and never updated `service_cases.current_owner_id`. The episode is the
  constrained truth; `decide()` reads the cached column. So the agent who won a claim owned
  the conversation by the exclusion constraint and was refused by the authorization ladder
  — AGENT alone does not carry `conversation.reply.customer`, ownership does.
  `assignFromRouting` had always written it; only the HTTP claim endpoint did not.
  `claim-race.test.ts` proves exactly-one-winner and never asks whether the winner can then
  act.
- **Nothing ever wrote QUEUED, ASSIGNED or ACTIVE (N-44).** Intake wrote `NEW`; only reopen
  and resolve wrote anything after. A real conversation therefore sat at `NEW` — and §21.4
  has no `new → resolved` row, so **slice 3's resolve endpoint was unreachable on every
  conversation the product had actually created.** Its tests passed because they seeded
  `ACTIVE` directly: the same trap that hid the missing resolve path itself.

`advanceStateIn` now records the move and the episode pair together, and four writers call
it — enqueue (`new → queued`), claim and routed assignment (`→ assigned`), and the owner's
first customer-visible reply (`assigned → active`, §21.4's "the reply itself", not
separately audited because the message IS the record). The SLA pause-span history is
continuous for the first time.

**Exit criteria, all met:** SLA arithmetic property tests including pause/resume and
retroactive holiday re-derivation ✅ · after-hours golden flow ✅ · customer-vocabulary
mapping with an internal-state leak test ✅ · **the whole lifecycle reachable from the
product** — intake → placement → reply → resolve → close, proven end to end from HTTP by
G-15 ✅

**Placeholder values seeded 2026-08-27** (`infrastructure/database/seed/`), all flagged
`is_seed_placeholder`: the §21.6 category tree, agent concurrency from §54's 3–6 envelope,
working hours of 10:00–19:30 Mon–Sat IST, and first-response 30 min / resolution 8 working
hours on a BUSINESS_HOURS basis. **The hours are the answer sir gave on 2026-08-25 while
answering about a different product, and were retracted** — they are a stand-in so the
clocks can run, not a confirmation. No holidays are configured at all, which is the
largest known gap. §68 gate 8 is what clears these.

**Still open, and genuinely the business's:** D-21 (real working hours and holidays) and
D-22 (real targets). Both block the pilot, neither blocks the build. N-17's release-on-close
landed with slice 3; its TTL half is D-05's (N-38).

**Blocked on the business, not on code:** every *value* here is unanswered — D-20/D-21
(working hours), D-22/D-23 (SLA targets and which promise model per team), D-24/D-25
(priority bands, warning/breach thresholds), D-26 (customer-facing wording). Config
entities ship with `is_seed_placeholder` seeds and the surfaces carry the flag through, so
the build proceeds and the **pilot gate** blocks on sign-off. Nothing goes in front of a
real customer on placeholder hours.

### Phase 7 — Attachments: object storage, scanning, DLP hooks, audit
**STATUS: COMPLETE (2026-08-28).** 748 tests, none skipped. Landed:

- **`packages/attachments`** — the pipeline as eight states with `BOUND` the only
  reachable one. §28.1 in capitals: "AN UPLOADED-BUT-UNSENT ATTACHMENT IS REACHABLE BY
  NOBODY. Binding to a message is what grants access." The reachability test runs over the
  whole enum rather than case by case, so a state added later is covered. `CLEAN → EXPIRED`
  is permitted (a clean orphan is still an orphan); `BOUND → EXPIRED` is not (§28.6 makes a
  bound attachment follow the conversation's retention, and collecting one would delete a
  live claim document on a housekeeping timer). `INFECTED` has no exit at all — a "retry
  the scan" path is a way to get a second opinion on malware.
- **D-07, answered "claims only" (2026-08-27).** Enforced in the POLICY, not a controller,
  so both surfaces ask one function and neither can answer differently. An ABSENT category
  is not-permitted rather than unrestricted — §21.5 lets a customer start without choosing
  one, and reading that as "any category" would invert the rule. Approvers per §44.3 are
  CTO + Claims; still awaiting their confirmation.
- **A deliberate deviation from §28.5, in the safe direction.** That table makes employee
  scanning FUTURE for V1-A; §28.2 states the condition that voids it — "It becomes
  unacceptable the moment D-07 admits customer uploads." It has. Scanning is mandatory for
  both kinds, because a shared pipeline cannot tell whose bytes are whose once they are in
  quarantine.
- **`DevAttachmentScanner`** — content sniffing, size verification and EICAR are real;
  malware detection, archive-bomb inspection, macro policy and DLP are not, and its health
  report says so in a sentence a test asserts on. §68 gate 5 should not pass on it. It
  refuses a ZIP container rather than guessing whether it is a .docx or an archive.
- **Migration 0007** widened `scan_verdict_check` to include REJECTED. Forcing a policy
  rejection into FAILED would say the scanner broke when it worked perfectly — and those
  answer different questions: "is our scanner healthy" (FAILED counts) versus "are we
  blocking bad uploads" (REJECTED and INFECTED are the evidence).
- **§28.4's ladder**, numbered in the code because the ORDER is the security property. The
  test that matters: a customer, in their OWN conversation, refused an internal-note
  attachment. Steps 2 and 3 both pass — the record exists and the conversation is theirs —
  and step 4 is the only thing that refuses. It is audited as `INTERNAL_NOTE_ATTACHMENT`
  rather than a generic miss.
- **§58's DLP hook, made useful without a provider.** Attachments inherit conversation
  sensitivity by JOIN rather than a copied column, so reclassifying a thread reclassifies
  its attachments with no migration — proven by reclassifying AFTER the attachment exists.
  Sensitivity and the DLP verdict are recorded on every download audit, which turns "who
  has been reading restricted material" into a query. The verdict reads NONE today because
  no provider supplies one, and that absence is visible rather than hidden.

**Exit criteria, all met:** pipeline state-machine tests including infected, oversized,
mismatched-MIME and unbound-expiry ✅ · storage-down degradation with text chat unaffected
✅ — proven three ways: a proven-clean file whose promotion fails returns to QUARANTINED
rather than being condemned, a scan that could not run records FAILED not REJECTED, and
every storage failure is FAIL_DEGRADED and retryable.

**Two additions recorded as additions, not transcriptions.** §32.4's alert table names no
attachment alert; `AttachmentScanBacklogNotDraining` applies its own "outbox growing
without draining / stuck worker" row to the other worker queue we now run, and the comment
in `alerts.yml` says so, so a reviewer can disagree deliberately. And a dev-only upload
endpoint exists because `MockObjectStorage` has no HTTP server — without it the dev stack
is non-functional. It fails closed on an unset `SL_ENV`, requires the mock driver, and
accepts bytes only against an already-granted key.

**Not built: real DLP or malware detection.** The seam is plumbed end to end — scanner →
sweep → `classification` → audit — and nothing fills it. That is N-06, the same recurring
cost D-07 commits us to, and the two are worth putting to CTO and Claims together.

### Phase 8 — Notifications: outbox, retries, dead-letter, channel adapters
- Notification pipeline end-to-end (dedupe, coalesce, suppression, preferences); INAPP + EMAIL transports; DLQ + replay tooling; consent check on customer-channel sends; website push fallback.
- Channel adapter framework hardened (webhook verify, idempotent receive, reconcile) — WhatsApp/SMS adapters built only when D-01 approves.
- Exit: provider-down drains-on-recovery test; duplicate-webhook idempotency test; DLQ visibility/alerting.

**Decisions taken 2026-08-28, recorded in `STARLINK_OPEN_QUESTIONS.md`:**
- **D-12** customer notification channel = **email**, but *split*: the customer half is
  deferred pending Sir's confirmation (it extends D-01 from option (a) to option (d)) and
  is blocked on D-31 (no durable customer address) and a real consent engine. The employee
  half proceeded.
- **N-07** email provider = **corporate SMTP relay**. Built; dormant until IT supplies a
  relay host. **N-18** closed §17.2's fifth identity operation (`resolveContactChannels`),
  which is what the transport had been missing an address from.
- **N-19** the in-app notification list is built. §19.6 and §20.7 had already specified it;
  only per-notification read state was engineering's, and was taken as such.
- **N-20** async fabric: **sweeps remain the V1-A form**; ADR-006 amended to be
  phase-conditional with an explicit trigger. **N-21** away/presence follows it — `isAway`
  stays false, and Part IV §52 puts presence leases in the shared backplane.
- **N-22** "website push fallback" in the line above is **closed as FUTURE**. The phrase
  appears to have been taken from Part IV §56's Website/App adapter row; the sections that
  own the question mark push FUTURE four times (§29.3, §15.9, §36.4, and the dependency
  register, which routes a push service to D-12 — answered with email). §36.4's two stated
  prerequisites, "a service and a mobile decision", are both unmet. **This plan line
  outran the architecture** and is retained only so the discrepancy stays visible.
- **N-24** no inbound webhook receiver in V1: every mention of one in the document is
  contingent on D-01 answering WhatsApp (§37.2, §16.5, §36.4, §39, §33), and D-01 answered
  web chat. The framework is built and dormant; §37.2 wants a *separate process* when one
  is needed, not a route on the API.
- **N-25** §56's "no reliance on tab staying open" is a real requirement whose current
  answer is D-12/email — and therefore **unmet in running code** until D-12's customer
  half is confirmed and unblocked.

### Phases 9–12 — status after the 2026-08-29 pass

Phases 9 and 10 are **blocked on contracts that do not exist**, and nothing in them is
partially implementable: an adapter cannot be written against an interface nobody has
published. Phase 11's local half and part of Phase 12's operational gate **were**
implementable and have been done. What follows records both.

**Landed 2026-08-29, from Phase 11:**

- **`packages/ai-assist` — the redaction boundary, built before a provider exists.**
  INTEGRATION_CONTRACTS §11 requires that "redaction happens *before* the provider
  boundary", and `AIProvider` already enforces it in its signatures by accepting only a
  `RedactedTranscriptRef`. Nothing produced one. Now `redactTranscript` does: structured
  turns rather than a concatenated prompt string (§65's red-team lists prompt injection
  first, and concatenation is its mechanism), customer-visible content only by default,
  PII patterns shared with the log redactor so one list protects both, and roles rather
  than names. Built now precisely because it cannot be built later under the pressure of a
  provider that has just been approved — sending transcripts to a third party is not
  reversible.
- **§68 gate 9 as a running configuration.** `DisabledAIProvider` is the installed
  provider (`SL_ADAPTER_AI=disabled`), refuses every capability as `FAIL_DEGRADED` — "the
  feature disappears, the conversation continues" — and is reported by `/readyz` without
  ever affecting readiness. An instance that refused traffic for want of an AI provider
  would make the assistant a hard dependency of the conversation, which is the inversion
  §36's advisory-only rule exists to prevent.
- **A boundary rule that makes "AI never decides" structural.** §57: *"hard compliance,
  entitlement, payment, policy and case state remain deterministic authority."* `authz/`,
  routing, service-case and the consent/IAM adapters may not import AI at all. Proven by a
  third fixture case in `verify-boundaries.ps1` — nobody writes `if (ai.saysDeny)`, they
  write a confidence threshold inside a routing branch, and the import edge is what catches
  that.

**Landed 2026-08-29, from Phase 12's operational gate (§68 gate 7):**

- **Six of fourteen alerts could never fire, three of them security alerts** (N-36). Seven
  metrics were declared and emitted by nothing, and the realtime gateway had no `/metrics`
  endpoint at all despite being scraped since Phase 3. All now have producers, including a
  new `MessagePageIndexHealthSweep` that runs §38's `EXPLAIN` probe in production against
  the same query shape the API pages with.
- **Histogram support in the metric registry.** Deferred there in writing "until the
  latency work lands (Phase 12)"; this is that. NFR-PRF-2's p95 is now measurable, with
  0.3s as an explicit bucket boundary so the alert fires on the SLO rather than on
  interpolation.
- **A guard for the whole class:** `alerts-have-producers.test.ts` fails the build on any
  alert whose series nothing emits, with a declared-waiver escape hatch (capped at two)
  for the one case that is legitimately blocked on a business decision.
- **Grafana dashboards, provisioned** (`infrastructure/monitoring/grafana/`). Grafana had
  run in the dev stack since Phase 1 with no datasource and no dashboards, so it opened on
  an empty screen and every metric the application published was invisible. Six of gate 7's
  seven concerns are now panelled — sockets, queue age, routing orphans, DLQ/outbox,
  DB/query health, security anomalies — plus SLA. **Channel errors is deliberately absent**
  (N-46): no external channel adapter is wired, so a panel there would draw an empty graph,
  and an empty graph reads as "nothing is happening" rather than "nothing is measured".
- **Three golden tests landed** — G-14 (object storage down, §34.4), G-15 (AI down, gate 9),
  G-16 (notification provider down, §34.3). See `STARLINK_TEST_STRATEGY.md` §2.
- **The load suite is NOT started** (N-47). The harness is local work; a meaningful run at
  §54's envelope is not, and no performance evidence has been manufactured. Blocked on N-03.

### Phase 9 — HRMS / Central IAM production adapters
**STATUS: BLOCKED, nothing implementable.** The work is "remote adapters against the real
contract", and no contract has been published (N-01, N-02, N-12). The shadow-reconcile job
of §12 step 2 diffs Local against Remote claims and cannot be written without the Remote
side to diff against. The cutover plan itself is already written (§12) and the property
that makes it safe — `principal_id` minted as the stable join key from day one, never
rewritten — has held since Phase 1.

- Remote IAM + directory adapters against the real contract; shadow-reconcile; cutover per INTEGRATION_CONTRACTS §12.
- Exit: cutover rehearsal in staging (flip, verify, flip back); exit-mid-session golden test against Remote.

### Phase 10 — CCS adapters (customer/work/consent/business objects)
**STATUS: BLOCKED, nothing implementable.** Same reason as Phase 9 (N-01). Every interface
these adapters will implement already exists in `shared-contracts` with a Local or Mock
behind it, which is what makes the cutover a configuration change; what does not exist is
anything to point them at.

- Remote CustomerContext/Opportunity/Policy/Claim/Booking/Payment/Consent/WorkOrchestrator/EventPublisher against CCS PRO contracts; Local orchestrator demoted to fallback per policy; enterprise audit publication verified.
- Exit: contract-conformance suites green against CCS staging; authority gate (Part IV §68.1) — no duplicated truth.

### Phase 11 — AI assistance and handoff
**STATUS: PARTIALLY LANDED 2026-08-29 — boundary built, provider blocked on N-05.** See the
status section above for what landed. **Not built, and why:** every capability that calls a
provider (intent classification at intake, RAG self-service, handoff summaries, copilot
drafts, risk signals) waits on N-05 — provider choice and a data-processing agreement for
redacted-transcript processing, owned by the CTO and Legal/DPO. RAG additionally needs an
*approved corpus*, which is a content decision nobody has made. ADR-022's flag reader is
deliberately deferred (N-42): a flag mechanism with no feature to gate is the same "built
and unreachable" pattern this pass existed to remove.

- ai-assist orchestration: intent classification at intake, FAQ/RAG self-service (approved corpus, citations), handoff summary (§37 payload), agent copilot (drafts, translation), risk signals; redaction before provider; flags per ADR-022; human-fallback-with-AI-off test.
- Exit: AI gate (Part IV §68.9) + red-team suite (prompt injection, tool overreach, sensitive-data refusal).

### Phase 12 — Load/failure/security testing, observability completion, production hardening
- Full golden + chaos + load suites (TEST_STRATEGY) at the §54 envelope; security review (§27.15 scope) as a hard gate; runbooks, dashboards, alert rules; production deployment decision (T-17) executed with infra owner; backup/PITR + restore rehearsal; rollback rehearsal.
- Exit: all ten Part IV §68 acceptance gates evidenced.
- **Hard prerequisite (recorded 2026-08-28):** §68's resilience gate covers "node,
  **Redis/backplane, queue**, DB, object store, CCS service and provider failure tests".
  Neither Redis nor the job fabric exists (N-20), so **the ADR-006 trigger must fire before
  this phase, not at it**. Adoption is blocked on N-03 (hosting target).

---

## 5. Per-phase definition of done (applies to every phase)

Durability proven for anything the phase persists · authorization server-side with negative tests · customer/internal isolation suites still green (regression) · retries idempotent · queue work cannot vanish (DLQ visible) · reconnect works · logs contain no prohibited PII (schema test) · audit-critical events attributable · metrics + alerts for the phase's new surfaces · adapters replaceable (conformance tests run against Mock and Local/Remote) · docs updated to match code.

## 6. Sequencing & parallelism

Critical path: 1 → 2 → 3 → 4 → 5 → 6. Phase 7 (attachments) and 8 (notifications) can proceed in parallel after 5. Phases 9/10 depend on external contract availability (tracked in OPEN_QUESTIONS; slippage does not block 11's Local-adapter development). Phase 12 runs continuously as gates but has a dedicated hardening window at the end.

## 7. Risks

| Risk | Mitigation |
|---|---|
| CCS/HRMS contracts undefined longer than expected | Local adapters are production-quality behind final interfaces; cutover is config |
| Business values (D-17..D-26) not signed off by Phase 6 | Config entities ship with FAKE seeds; pilot gate blocks on sign-off, build does not |
| D-01 lands on WhatsApp late | Channel framework ready Phase 8; BSP adapter is additive; webhook receiver split is a compose change |
| Team unfamiliarity with chosen stack | Stack follows the doc's own proposals (TS/NestJS/Next.js); ADR-001 is the only major deviation and is repository-isolated |
| Scope creep into CRM/ticketing | ADR-024 constitutional list reviewed at every phase gate |
