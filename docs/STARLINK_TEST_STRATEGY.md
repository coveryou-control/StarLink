# STARLINK_TEST_STRATEGY.md

**Status:** PROPOSED. Sources: brief §53–54, doc Part IV §65 (test lab) and §68 (acceptance gates), §46 rules (property tests), §27.15 (security review scope).
**Principle:** production acceptance is evidence, not prose (§68). No performance claim is made before its test exists (brief §54).

---

## 1. Test layers and tooling

| Layer | Scope | Tooling | Runs |
|---|---|---|---|
| Unit | domain logic: authz decision function, state machines, SLA arithmetic, cursor codec, visibility rules | Vitest | every commit |
| Integration | repository + PG/Redis/MinIO via testcontainers: write path, outbox relay, claim, scan pipeline, notification pipeline | Vitest + testcontainers | every commit |
| Contract / conformance | every adapter family: one shared conformance suite executed against Mock, Local, and (Phases 9–11) Remote-against-staging; API contract tests from OpenAPI for both route trees | Vitest + schema validation | every commit (mock/local), nightly (remote) |
| Authorization matrix | role × scope × action × resource grid incl. every negative case; deny==not-found indistinguishability | table-driven Vitest | every commit |
| Property / invariant | §46 rules as executable properties (fuzzed) — see §3 | fast-check | every commit |
| Realtime / race | multi-instance correctness, seq gaps, reconnect, revocation-mid-socket | Vitest + real Socket.IO clients against compose | every commit (small), nightly (full) |
| E2E browser | employee + customer surfaces; internal-note composer distinctness; offline/reconnect/draft recovery; pending-send states | Playwright | PR + nightly |
| Failure injection / chaos | §5 scenarios via compose kill/pause/latency (toxiproxy) | scripted, nightly + pre-gate | nightly |
| Security | §7 suite + gated human review | ZAP baseline, dependency scan (osv), SAST (Semgrep), custom probes | PR (fast) + pre-pilot (full) |
| Load | §6 suite | k6 (+ Socket.IO scenario driver) | pre-gate + on demand |

CI gates (all blocking): typecheck · lint · dependency-cruiser boundaries · unit+integration · authz matrix · isolation properties · log-schema PII test · customer-bundle inspection (no employee/internal-note code) · unpermissioned-operation build failure (ADR-016).

### The verification gate: `pnpm test:verify`

`pnpm test` is **not** the gate. Turbo reports "all tasks passed" when tests inside a task
*skipped*, and that is not hypothetical: on 2026-08-25 a connection-exhaustion problem
made eleven database tests skip, and the run reported green with a total 48 lower than
the previous one. The only signal was a number going down, and nobody diffs numbers.

`pnpm test:verify` runs the whole suite serially with a JSON report and fails if anything
skipped **or** failed, naming each. Three supporting decisions:

- **Database test files run one at a time** (`fileParallelism: false`). Each opens its own
  pool against the same managed database; in parallel they exhaust its connections, and
  the symptom is a suite that quietly proves less than it claims rather than an error.
- **One vitest workspace**, so the root run and `pnpm --filter <pkg> test` are the same
  run. They were not — the root config ignored per-package `setupFiles`, so `employee-web`'s
  draft tests failed at the root and passed in the package. A root suite that disagrees
  with the package suites teaches people to trust whichever is currently green.
- **The gate is itself tested.** Its first version checked for vitest statuses `pending`
  and `todo`; vitest emits `skipped`, so it reported "none skipped" over a report holding
  eighty-six of them. It now allow-lists what *did* run (`passed`, `failed`) rather than
  deny-listing skip spellings, and it was verified by pointing `SL_DATABASE_URL` at a dead
  port and confirming it fails. A guard that cannot fail is worse than no guard.

---

## 2. Golden tests (mandatory; from brief §53 — each is a named CI job)

**Implementation status as of 2026-08-29** — recorded here because a table of tests that
do not exist reads, at a glance, like a table of tests that pass.

| # | Status | Where |
|---|---|---|
| G-09 | ✅ **implemented** | `apps/api/src/durability.test.ts` — spawns the real API, **SIGKILL** (not SIGTERM: SIGKILL cannot be trapped, so no shutdown hook and no flush), asserts the message is committed with its outbox row PENDING, then a relay in a *different* process drains and publishes it |
| G-11 | ✅ implemented | `infrastructure/database/.../message-store.test.ts` — retried `client_message_id` returns the original |
| G-12 | ✅ implemented | `admin-store.test.ts` + gateway socket tests; `inactive_owner_open_conversations` verified 0→1→0 |
| G-13 | ✅ implemented | `apps/realtime-gateway/src/gateway.test.ts` — revocation closes a live socket |
| G-19 | ✅ **implemented** | Two halves: `customer-projection.test.ts` fuzzes the serialiser over 1,000 randomised rounds, and `apps/api/src/customer-isolation.test.ts` runs a real customer session against the live API (11 tests) — a projection can be perfect and the route still leak by loading the wrong row |
| G-22 | ✅ implemented | `admin-store.test.ts` |
| G-23 | ✅ implemented | Cross-customer isolation at the HTTP boundary: another customer's thread returns the same status AND the same body as one that does not exist, and holds under a concurrent burst |
| G-24 | ✅ implemented | `infrastructure/guards` — config namespace + platform independence |
| G-06 | ✅ implemented | `infrastructure/database/.../claim-race.test.ts` — "G-06 — two agents claim the same conversation": one winner, one clean `ALREADY_ASSIGNED`. **Status corrected 2026-08-29**; this row read "Phase 5 — claim/queue does not exist yet" long after it did |
| G-07 | ✅ implemented | Same file, "G-07 — a hundred agents claim from one queue": one winner, 99 clean rejections, no deadlock (`FOR UPDATE SKIP LOCKED`) |
| G-14 | ✅ **implemented 2026-08-29** | `apps/api/src/golden-g14-storage-down.test.ts` — §34.4 clause by clause against a real database with an injected failing `ObjectStorageProvider`: the upload refuses as `STORAGE_UNAVAILABLE` and writes **no attachment row** (so "a message is never sent claiming an attachment that does not exist" is structural), a text send still succeeds, a download refuses as temporarily unavailable rather than 404, and the metadata stays legible. The wire now answers **503**, not the uniform 404 — see the note below |
| G-15 | ✅ **implemented 2026-08-29** | `apps/api/src/golden-g15-ai-down.test.ts` — §68 gate 9. A whole conversation walked end to end against a live API with `SL_ADAPTER_AI=disabled`: intake → placement → agent reply → customer reply → resolve, plus `/readyz` returning **200 while the AI check reads DOWN**. That asymmetry is the gate: identity DOWN means no traffic, AI DOWN must not. **This test found two real defects** — see §2.1 |
| G-16 | ✅ **implemented 2026-08-29** | `apps/api/src/golden-g16-notifications-down.test.ts` — §34.3 against the real `PgNotificationOutbox` and sweep, with one transport failing and one healthy. Adds the two cross-cutting claims the sweep's own unit tests cannot make: a message still sends during the outage (P-05), and **in-app keeps working while the external channel fails** |
| G-03, G-08 | ⬜ **Redis-gated** | require two instances and a shared backplane |
| G-01, G-02, G-04, G-05, G-18 | ⬜ **harness not built; target-scale run needs N-03** | See §2.2 |
| G-10, G-17, G-20, G-21 | ⬜ later phases | webhooks, database failover, scoped grants |

### 2.1 What G-15 found

A golden test earns its keep by failing for a real reason, and this one did — twice, on the
primary customer-service path:

1. **A claimed conversation could not be replied to.** `claimConversation` opened the
   ownership episode and never updated `service_cases.current_owner_id`. The episode is the
   constrained truth, but `decide()` reads the cached column — so the agent who won a claim
   owned the conversation by the exclusion constraint and was refused by the authorization
   ladder, because AGENT alone does not carry `conversation.reply.customer` and ownership
   does. `assignFromRouting` had always written it; only the HTTP claim endpoint, the one
   agents actually use, did not. `claim-race.test.ts` could not see it: it proves
   exactly-one-winner and never asks whether the winner can then do anything.

2. **The arrival half of §21.4 was never wired.** Nothing wrote `QUEUED` or `ASSIGNED`, and
   nothing moved a conversation to `ACTIVE`. A real conversation sat at `NEW` from intake
   onwards — and §21.4 has no `new → resolved` row, so **the resolve endpoint was
   unreachable on every conversation the product had actually created**. Its own tests
   passed because they seeded `ACTIVE` directly, which is the same trap that hid the
   missing resolve path in the first place: a test that manufactures the state it exercises
   cannot notice that nothing upstream produces it.

Both are fixed (`advanceStateIn`, and the four writers that now call it). The lesson is the
one §2 already states, sharpened: a test that seeds its own preconditions proves the code
downstream of them and nothing about reachability. **Only a test that starts from an HTTP
request can say the product works.**

### 2.2 The load suite — what can be built here and what cannot

G-01, G-02, G-04, G-05 and G-18 are the scale envelope, and they split cleanly:

- **The harness can be developed locally.** Nothing about writing the driver, the
  measurement, or the assertions needs the target environment, and it can be exercised
  against the local Postgres at small numbers to prove it measures what it claims.
- **A meaningful RUN cannot happen here.** §54's envelope is 500 employee and 1,500 customer
  connections; this machine has no Docker, one Postgres process and one API instance, and
  G-03/G-08 additionally need Redis. Numbers produced against it would describe this
  laptop, not the product — and a performance figure attributed to the wrong environment is
  worse than none, because it gets quoted.

**So the harness is not built yet and no performance evidence is manufactured.** Both wait
on **N-03** (hosting target, and whether managed Redis is part of it). Recorded rather than
attempted.

### 2.3 A degradation that is deliberately NOT the uniform 404

§27.3 makes "you may not" and "it does not exist" indistinguishable, and every refusal in
the product obeys it. Storage being down is the one exception, added with G-14, and the
reasoning matters because it looks like a violation:

A 404 says the file is not there. A client renders "no such attachment", the user believes
their document was lost and uploads it again — which is the "broken image or silent blank"
§34.4 explicitly forbids, arrived at by a different route. So `STORAGE_UNAVAILABLE` answers
**503** with `attachment_temporarily_unavailable`.

§27.3 is not weakened, because of WHEN that is reachable: only after the authorization
ladder has already passed. Someone who may not see the attachment gets the uniform 404 and
never reaches it, whether storage is up or down. The 503 discloses a fact about the SYSTEM,
never about the resource or the actor — which is the distinction §27.3 actually draws.

| # | Golden test | Proves |
|---|---|---|
| G-01 | 500 employee realtime connections | envelope |
| G-02 | 1,500 customer connections | envelope |
| G-03 | 2,000 combined sockets, 50% reconnect storm within 60s | backplane stability, jitter/backoff |
| G-04 | 100 msg/s sustained 5 min | p95 ack in target; zero loss/duplication |
| G-05 | 10× async queue burst | backlog drains in recovery SLO; chat sends unaffected |
| G-06 | Agent double-claim race (2 claimers) | exactly one winner, loser gets ALREADY_ASSIGNED |
| G-07 | 100 simultaneous claims on one queue item | one winner, 99 clean rejections, no deadlock |
| G-08 | Redis restart during active chat | degraded presence/fan-out; zero message loss; auto-recovery |
| G-09 | API instance kill after DB commit, before publish | outbox relay heals; event delivered exactly-once-effectively |
| G-10 | Duplicate webhook delivery | absorbed idempotently; no duplicate customer message |
| G-11 | Duplicate message send (same client_message_id) | original returned; no second message |
| G-12 | Employee deactivation mid-chat | session revoked, socket closed, no new assignments, owned conversations surfaced, history intact |
| G-13 | Permission revoked mid-socket | next read/send/subscribe denied; room membership removed |
| G-14 | Object storage down | text conversation unaffected; attachment path explicitly degraded |
| G-15 | AI provider down | full human workflow unaffected (flag-off equivalence) |
| G-16 | Notification provider down | messages unaffected; outbox accumulates; drains on recovery; DLQ visible |
| G-17 | Database failover (replica promotion) | explicit degradation, then recovery; acknowledged sends durable |
| G-18 | Reconnect storm (deploy simulation) | no thundering herd; bounded reconnect rate |
| G-19 | **Customer API can never return an internal note** | property-fuzzed across every customer route, cursor, search, attachment, realtime event |
| G-20 | Unauthorized TL cannot read team customer history | scoped-grant model holds; attempt audited |
| G-21 | Claim-sensitive data hidden from ordinary sales role | sensitivity segmentation |
| G-22 | `inactive_owner_open_conversations == 0` after exit flows | ownership never in limbo |
| G-23 | Cross-customer isolation fuzz (IDs, cursors, search, attachments) | zero existence leakage; deny==404 |
| G-24 | NorthStar-off / standalone boot | clean checkout starts with no foreign config, `starlink`-only schemas |

---

## 3. Property tests (the §46 rules, executable)

Each rule becomes a fast-check property or scenario assertion; the suite is the constitution's regression net. Highlights: acknowledged ⇒ durable (kill-injection); authz-before-content on generated route permutations; participation grants exactly-one-conversation; unknown permission ⇒ deny; internal-note fail-closed send when visibility indeterminate; exactly-one-owner (exclusion constraint + concurrent transfer fuzz); no-invisible-waiting (every unassigned conversation appears in a queue view); append-only ledger (UPDATE/DELETE attempts fail at DB grant level); revocation-next-request; sockets-die-with-sessions; realtime-additive (client that missed all events converges after re-fetch); immutable history (edits are revisions); SLA-never-scores-individuals (no per-agent SLA endpoint exists — API surface test).

## 4. Isolation & serialisation tests

- Customer serialiser allow-list snapshot tests: adding a field to a shared type does **not** appear on a customer payload until explicitly allow-listed (fail-closed, §27.16).
- Repository-layer visibility predicate tests: raw SQL of every customer-tree query contains the visibility filter (query-plan assertion, not code review).
- Channel adapters reject non-`CUSTOMER_VISIBLE` outbound at type + runtime layers.
- Realtime publish-time kind-check: internal-note events never fan out to a customer-session room (fuzzed room membership).

## 5. Failure-injection catalogue (brief §43 + Part IV §62 — each scenario scripted)

DB down (fail visibly, readiness drops, no fake-empty inbox) · Redis down (G-08) · queue down (outbox accumulates bounded; alerts) · gateway node kill (LB removes; reconnect) · notification provider down (G-16) · object storage down (G-14) · AI down (G-15) · WhatsApp/provider timeout + ambiguous result (UNKNOWN → reconcile, never optimistic-delivered) · partial deploy (old+new instances coexist; additive schema) · instance crash post-commit pre-publish (G-09) · duplicate webhook (G-10) · duplicate send (G-11) · exit mid-session (G-12) · revoke mid-socket (G-13) · ownership transfer collision (last-writer loses cleanly, episode history consistent) · customer reconnect storm (G-03/18) · IAM unavailable (cached session window per policy; privileged/new authz fails closed) · Consent unavailable (no new proactive outbound; inbound continues) · CY Brain down (zero impact on chat).

## 6. Load suite (`infrastructure/load`, k6)

**Scenarios (composable):** employee-socket population ramp (→500) · customer-session ramp (→1,500, burst profile) · sustained message mix (100 msg/s: 70% internal, 30% customer; realistic thread distribution) · typing/presence noise (P2, sheddable — verify shedding) · queue-claim contention · intake surge (campaign spike: 300 intakes/min with no agent capacity) · attachment upload wave (separate; direct-to-storage confirms API bypass) · notification burst (10×) · reconnect storm · after-hours opening surge (overnight backlog routing, NFR-PRF-8).

**Measured:** p50/p95/p99 per operation · error rate · CPU/mem per app · PG latency + rows-examined ratio · Redis latency · queue lag/oldest-age · socket count/churn · Node event-loop lag · time_to_first_assignment · abandonment.

**Acceptance thresholds (initial; revised only with evidence, marked PROPOSED like the doc's NFRs):**

| Metric | Target |
|---|---|
| Message send ack (excl. delivery) | p95 < 300 ms, p99 < 800 ms @ 100 msg/s |
| Thread open + first page | p95 < 500 ms |
| Realtime delivery (connected) | p95 < 1 s end-to-end |
| Routing decision (local orchestrator) | p95 < 400 ms |
| Time-to-first-assignment under surge | queue-ordered, monotone, zero lost intakes |
| Error rate under envelope | < 0.1% on P0 paths |
| 10× queue burst recovery | backlog drained < 15 min after burst ends, chat p95 unaffected |
| Reconnect storm (50% of 2,000 in 60s) | all re-authorized < 120 s, no gateway OOM |
| Rows-examined ÷ rows-returned (message page) | ≤ 3 sustained (alert threshold) |
| Zero-invariants | unauthorized cross-customer reads = 0 · internal-note leaks = 0 · inactive-owner conversations = 0 · lost acknowledged messages = 0 |

## 7. Security testing

- **Automated per PR:** dependency scan, SAST, secret-scan, headers/CSP assertions, authz matrix, rate-limit tests (per IP/session/principal/conversation/webhook — multi-instance via Redis counters), uniform-response timing checks on auth failures.
- **Pre-pilot human review (hard gate, §27.15 scope):** object-check on every content path with negative tests · adversarial customer-isolation session · internal-note boundary incl. realtime + adapters · session revocation incl. reconnect path · attachment authorization incl. internal-note attachments · rate limits + uniform responses under timing observation.
- **Abuse suite:** OTP brute-force limits, intake bot-burst (challenge hooks), attachment abuse (size/type/zip-bomb), search-as-exfiltration (scope + rate + audit-with-term), cursor tampering (HMAC), SSRF probes on any URL-accepting field, injection fuzz (SQL/NoSQL/XSS — messages render as text only).
- **AI red-team (Phase 11):** prompt injection via customer messages and attachment text, sensitive-data elicitation, tool overreach, unsupported policy answers, handoff-correctness sampling.

## 8. Data & privacy tests

Log-schema test: structured logs validated against an allow-list schema; fixtures containing phone/email/PAN/OTP/tokens/message bodies must be redacted or the test fails · audit completeness: every audit-critical action in a traced E2E run has a ledger row with actor/action/target/outcome/correlation_id · request-context expiry (partition drop) leaves ledger meaningful · erasure propagation drill (message → search index → AI derivatives → exports) once D-06 lands · backup/restore rehearsal incl. attachments + audit (NFR-RCV-1), restore re-applies post-backup deletion events.

## 9. Environments

Unit/integration: ephemeral testcontainers · full-stack + chaos + E2E: compose profile (`compose.test.yaml`, 2×api, 2×gateway, workers, PG replica pair, Redis, MinIO, toxiproxy) · load: dedicated compose.load.yaml or staging; **never production data anywhere** (NFR-DAT-6) · staging mirrors production topology before the pilot (§35.6).

## 10. Gate mapping (Part IV §68 → evidence)

| Gate | Evidence |
|---|---|
| 1 Authority | contract-conformance + ADR-024 review checklist |
| 2 Correctness | G-04/06/07/09/10/11 + outbox/idempotency integration suites |
| 3 Scale | G-01/02/03/04/05 + §6 thresholds |
| 4 Resilience | §5 catalogue, all scripted scenarios green |
| 5 Security | §7 automated + human review sign-off |
| 6 Privacy | §8 suite + D-06 policy configured |
| 7 Operational | dashboards/alerts exist for every §6-measured signal + the two invariant gauges |
| 8 Business | D-17/20/21/22/23/25/26 values configured and signed (OPEN_QUESTIONS) |
| 9 AI | G-15 + red-team + RAG permission tests |
| 10 Rollback | canary + rollback rehearsal; expand→migrate→contract audit of all migrations |
