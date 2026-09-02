# StarLink — development status against the Module / Feature tracker

**As at 2026-08-29.** Reconciled feature by feature against the repository, not against the
plan. Verification at the bottom.

## How to read the status column

| Status | Means |
|---|---|
| **Built** | Reachable in the running product by the path a real user takes, and covered by tests |
| **Built · value pending** | Mechanism complete and tested; a *business value* it consumes is unratified (seeded and flagged) |
| **Domain only** | Logic exists and is tested; **no surface reaches it** — not usable |
| **Interim** | Works through a stand-in that is explicitly, visibly non-authoritative |
| **Partial** | A meaningful part is done; the remainder is named |
| **Blocked** | Cannot start — the named dependency does not exist |
| **Not started** | Deliberately not begun |
| **Deferred** | A decision was taken not to build it now |

The distinction that matters most is **Built** versus **Domain only**, and it is why this
report is written against the repository rather than against the plan. This project has
twice shipped a complete, tested domain with nothing calling it — most recently the
resolve/close path, which passed its own tests for weeks while being unreachable from any
surface a user touches.

**As of today nothing is in that state**, which is a change from a week ago rather than a
standing property. The two cases found were closed on 2026-08-28 and 2026-08-29.

---

## Headline

| | Count |
|---|---|
| Built (incl. value-pending and interim-by-design) | **44** |
| Interim — a visible stand-in behind the final interface | **3** |
| Partial | **15** |
| Blocked on an external dependency | **25** |
| Not started / backlog | **12** |
| Deferred by decision | **1** |
| **Total** | **100** |

**Every one of the 25 blocked items traces to a decision engineering cannot take:**
CCS/HRMS contracts (N-01/N-02/N-12) — 12 items; the AI provider and its DPA (N-05) — 6;
the hosting target and whether managed Redis is in it (N-03) — 5; retention policy
(D-06) — 1; and an authenticated customer identity that does not exist (SL-005) — 1.

Two further items are *partly* blocked and appear above as Partial or Interim rather than
Blocked, because a useful part of each is working today: business-object links (SL-019) and
the consent adapter (SL-071).

A further **five Built items are waiting on a business value**, not on code: the reopen
window (D-08), the category tree (D-17/D-18), working hours and holidays (D-21) and SLA
targets (D-22/D-23). Each ships with a seeded placeholder that is flagged as such
everywhere it surfaces. **Nothing goes in front of a real customer on placeholder hours.**

---

## 1. Product & Experience

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-001 | Employee 1:1 chat | **Built** | Send/read/history/reconnect; durability golden test G-09 |
| SL-002 | Internal group chat | **Built** | Membership + history rules enforced server-side (BR-07) |
| SL-003 | Channels / department chat | **Not started** | `ConversationType` has no channel kind. Distinct from group chat: persistent, org-scoped membership. Not begun |
| SL-004 | Customer website chat | **Built** | Intake → placement → reply → resolve proven end to end (G-15) |
| SL-005 | Customer app chat | **Blocked** | Needs My Account / authenticated customer identity. No such system to integrate |
| SL-006 | Unified agent inbox | **Partial** | `employee-web` lists and opens conversations. **No notification bell** — the four in-app endpoints exist and no UI consumes them |
| SL-007 | Internal notes | **Built** | Structurally excluded from every customer route; fuzz + live-API tests (G-19, G-23) |
| SL-008 | Reply / quote reply | **Partial** | `replyToMessageId` accepted by the API and scoped to the conversation (a reply cannot reference another thread). **No UI** on either surface |
| SL-009 | Read / unread state | **Built** | Per-principal, accurate under concurrency |
| SL-010 | Typing indicator | **Built** | Gated on actual channel join, throttled per socket |
| SL-011 | Presence | **Partial** | In-process only. Cross-instance presence needs the shared backplane (**N-03**); "away" therefore always reads false |
| SL-012 | Draft autosave | **Built** | IndexedDB on `employee-web`. Deliberately **not** on the customer surface — shared devices |
| SL-013 | Mobile responsive UI | **Partial** | Viewport and responsive CSS on both surfaces, incl. the iOS 16px zoom guard. Not yet exercised on real devices |

## 2. Conversation Domain

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-014 | Canonical Conversation ID | **Built** | Immutable, channel-independent |
| SL-015 | Participants with roles | **Built** | Participation ≠ ownership, enforced by `decide()` and negative tests |
| SL-016 | Conversation state machine | **Built** | §21.4 transcribed once. **Completed 2026-08-29** — the arrival half (`queued`/`assigned`/`active`) had never been wired, which made resolve unreachable |
| SL-017 | Ownership episodes | **Built** | Append-only, effective-dated, one owner per instant by database exclusion constraint |
| SL-018 | Service case metadata | **Built** | Category, priority, SLA, outcome; one case spans many conversations |
| SL-019 | Conversation ↔ business object links | **Partial · blocked** | `business_links` table and the link model exist. Nothing to link to until CCS adapters (**N-01**) |
| SL-020 | Reopen window | **Built · value pending** | Both branches (same thread / new linked thread). Window length is **D-08**; config-driven, no hard-coded 7 days |

## 3. Messaging

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-021 | Durable message write | **Built** | Persist-before-publish; G-09 kills the API with SIGKILL and the relay heals |
| SL-022 | Client idempotency key | **Built** | G-11 — a retry returns the original message |
| SL-023 | Cursor pagination | **Built** | Signed opaque cursor, no OFFSET; rows-examined ratio now monitored in production |
| SL-024 | Delivery state | **Partial** | Delivery/reconciliation logic built in `packages/channels`. No external channel exists to report against |
| SL-025 | Message edits | **Not started** | Backlog (P2) |
| SL-026 | Message reactions | **Not started** | Backlog (P2) |
| SL-027 | Scheduled messages | **Not started** | Backlog (P2). Would need send-time consent recheck |

## 4. Realtime & Scale

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-028 | Stateless API instances | **Partial** | The API holds no session state, but multi-instance has never been run or proven. Needs **N-03** |
| SL-029 | Realtime gateway | **Built** | Separate process, own auth, socket revocation (G-13). Gained a `/metrics` endpoint 2026-08-29 |
| SL-030 | Redis shared backplane | **Blocked — N-03** | In-process backplane only. This is the single largest structural gap: it blocks SL-011, SL-028, SL-074 and §68's resilience gate |
| SL-031 | Reconnect with backoff + jitter | **Partial** | Server tolerates a storm (ping/timeout tuned, connection ceiling per principal) and now measures it. Client backoff and the storm test (G-18) need the load harness |
| SL-032 | Backpressure tiers | **Not started** | ADR-020 records the P0/P1/P2 priority decision. **No implementation** — nothing sheds typing or AI ahead of message sends under load |
| SL-033 | Load test harness | **Blocked — N-03** | Harness is local work and could be written; a meaningful run at §54's envelope needs the target environment. **No performance numbers have been produced**, deliberately |

## 5. Routing & Work

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-034 | Category / sub-category intake | **Built · value pending** | Two-level configurable taxonomy. The tree itself is **D-17/D-18**, seeded and flagged |
| SL-035 | Relationship-aware routing | **Blocked — N-01** | Belongs to the CCS Work Orchestrator; no local routing truth by design |
| SL-036 | Skill / language routing | **Blocked — N-01** | As above |
| SL-037 | Atomic queue claim | **Built** | G-06 (2 claimants) and G-07 (100 claimants, one winner, no deadlock) |
| SL-038 | Weighted chat capacity | **Partial** | Ceiling enforced atomically at placement. Holds are now released on resolve, but the 120s TTL still expires first, so it limits **simultaneous placement, not sustained workload**. Needs **D-05** |
| SL-039 | Short-absence cover | **Built** | Ownership does not move; the response says so explicitly |
| SL-040 | Extended leave reassignment | **Blocked — N-01** | Needs HRMS leave events |
| SL-041 | Employee exit recovery | **Built** | G-12/G-22 — the inactive-owner count goes 1 → 0 and is alerted on |
| SL-042 | Transfer with reason | **Built** | Reason mandatory, audited, both parties notified |
| SL-043 | Escalation | **Built** | A level on an orthogonal axis, never a state |

## 6. SLA & Business Hours

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-044 | Team business calendars | **Built · value pending** | Versioned, effective-dated, explicit IANA timezone. Real hours and holidays are **D-21** — none configured |
| SL-045 | After-hours queueing | **Built** | Acknowledged with no countdown; work stays visible in the queue |
| SL-046 | First-response SLA | **Built · value pending** | Computed on read, so a corrected calendar corrects history. Targets are **D-22/D-23** |
| SL-047 | SLA at-risk alert | **Built** | Warning → breach → escalation, each firing once. Metrics and alerts live |

## 7. Channel Adapters

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-048 | Website channel adapter | **Built** | The native widget path; D-01 chose web chat for V1 |
| SL-049 | WhatsApp adapter | **Not started** | Needs a BSP decision. Inbound webhook receiver and idempotency framework are built and unused |
| SL-050 | Email adapter | **Not started** | Distinct from the email *notification* transport, which is built. Needs **N-07** and a mailbox decision |
| SL-051 | SMS adapter | **Not started** | Backlog |
| SL-052 | Voice / call linkage | **Not started** | Needs CCS Dialer |
| SL-053 | Channel binding model | **Partial** | `channel_bindings` table and reconciliation logic exist; no second channel to bind |

## 8. Attachments

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-054 | Direct object-storage upload | **Built** | Pre-signed, quarantine-prefixed; the API never proxies bytes |
| SL-055 | Malware scan | **Interim** | Dev scanner behind the final interface, visibly non-authoritative. A real scanner is a **buy decision** |
| SL-056 | MIME / size validation | **Built** | Server-side; the declared extension is never trusted |
| SL-057 | DLP / sensitive data scan | **Not started** | Backlog; hooks exist in the pipeline |
| SL-058 | OCR / classification | **Not started** | Backlog |

## 9. Notifications

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-059 | Transactional outbox | **Built** | No committed message without a recoverable event |
| SL-060 | In-app notifications | **Built** | Deduped, coalesced with a count, permission-safe. **Server side only — see SL-006 for the missing bell** |
| SL-061 | External notification adapters | **Partial · blocked** | SMTP transport built and switched off by default (`SL_NOTIFY_TRANSPORTS=inapp`). Needs a relay from IT (**N-07**); customer-facing needs **D-31** |
| SL-062 | Dead-letter / retry console | **Built** | Admin endpoints for counts, DLQ listing and replay; G-16 proves the outage behaviour |

## 10. Identity & IAM

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-063 | Interim employee identity adapter | **Built (interim by design)** | Every record stamped `TEMPORARY_AUTHORITY`; that visibility *is* its acceptance criterion |
| SL-064 | HRMS employee directory adapter | **Blocked — N-01/N-02** | No contract published. Cutover plan written; `principal_id` is already the stable join key |
| SL-065 | Central IAM authorization adapter | **Blocked — N-01/N-12** | As above |
| SL-066 | Contextual authorization | **Built** | Role + scope + purpose + ownership + object, with a server-side matrix of negative tests |
| SL-067 | Session / socket revocation | **Built** | G-13 — a revoked principal's live socket closes |

## 11. Privacy, Security & Audit

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-068 | PII masking / tokenisation | **Blocked — N-01** | Belongs to the CCS privacy engine; building a second one is forbidden by rule 11 |
| SL-069 | Privileged read audit | **Built** | Actor, target, purpose, time. Refusals audited too, and now counted for the security alert |
| SL-070 | Customer / internal data isolation | **Built** | Allow-list projection fuzzed over 1,000 rounds, plus live-API isolation tests |
| SL-071 | Consent eligibility adapter | **Interim · blocked** | Mock behind the final interface, checked at send time and fails closed. Canonical consent is **N-01** |
| SL-072 | Retention / legal hold hooks | **Blocked — D-06** | Three tables carry a retention intent and **nothing expires anything**. Needs the policy, not a number |
| SL-073 | Security headers / CSRF / CSP | **Partial** | `X-Frame-Options: DENY` and a restrictive CSP are set. CSRF posture depends on the cookie/session model and has not been separately reviewed |
| SL-074 | Rate limiting & abuse | **Partial** | In-process limiter on search (30/min). **Not distributed** — per-instance limits are not limits once there are two instances (**N-03**) |

## 12. AI & Copilot

**All six are blocked on N-05** — the provider choice and a data-processing agreement for
redacted-transcript processing, owned by the CTO and Legal/DPO. RAG additionally needs an
*approved corpus*, which is a content decision nobody has been asked for.

What **is** built, deliberately ahead of any provider, is the part that must not be written
under deadline pressure once one is approved:

- **The redaction boundary** (`packages/ai-assist`). Structured turns rather than a
  concatenated prompt string — concatenation is the mechanism behind prompt injection;
  customer-visible content only by default; PII patterns shared with the log redactor so
  one list protects both; roles rather than names. Sending transcripts to a third party is
  not reversible, which is why this exists before there is anyone to send them to.
- **§68 gate 9 as a running configuration.** The installed provider refuses every
  capability as `FAIL_DEGRADED`, and golden test **G-15** walks a whole conversation with
  AI entirely disabled — including `/readyz` returning 200 *while* the AI check reads DOWN.
  An instance that refused traffic for want of an AI provider would have made the assistant
  a hard dependency of the conversation.
- **A build-breaking rule that AI can never decide.** Authorization, routing, service-case
  and the consent/IAM adapters may not import AI at all, proven by a fixture that fails the
  build on a deliberate violation.

| ID | Feature | Status | Note |
|---|---|---|---|
| SL-075 | Approved FAQ / RAG | **Blocked — N-05** | Also needs an approved knowledge corpus |
| SL-076 | Intent classification | **Blocked — N-05** | Routing stays deterministic regardless; AI would be a signal only |
| SL-077 | Conversation summary | **Blocked — N-05** | |
| SL-078 | AI → human handoff pack | **Blocked — N-05** | Additionally **N-40**: nobody has been asked whether an internal note may be sent to an external processor |
| SL-079 | Reply drafting | **Blocked — N-05** | |
| SL-080 | Risk signals | **Blocked — N-05** | |

## 13. Search & Analytics

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-081 | Scoped conversation search | **Built** | Scope is a required parameter — an unscoped search does not compile |
| SL-082 | SearchProvider abstraction | **Built** | Postgres-native today, replaceable without touching UI or domain |
| SL-083 | Queue / load dashboard | **Partial** | Grafana dashboards provisioned 2026-08-29 (queue age, orphans, DLQ, DB health, security). The **operator-facing in-product** view is not built |
| SL-084 | Operational metrics | **Built** | 22 series with live producers. **Six alerts could never fire until 2026-08-29** because their metrics were emitted by nothing; a guard now fails the build on that |
| SL-085 | Structured logging | **Built** | Central redaction; message bodies and contact details cannot reach a log |
| SL-086 | Distributed tracing | **Deferred** | Correlation IDs answer the same questions in a small topology. Revisit at the multi-service step |

## 14. Data & Platform

| ID | Feature | Status | Evidence / what remains |
|---|---|---|---|
| SL-087 | PostgreSQL canonical store | **Built** | ADR-001 recorded; transactions, indexes and paging verified by spike |
| SL-088 | Database migrations | **Built** | Versioned, expand→migrate→contract discipline; 10 applied |
| SL-089 | Object storage | **Interim** | Mock behind the final interface; MinIO in the dev stack. `remote` refuses to start rather than degrade silently. Needs **N-03** |
| SL-090 | Durable job queue | **Blocked — N-03** | Database-backed sweeps stand in. Real queue needs Redis; this also blocks §68's resilience gate |
| SL-091 | Secrets / KMS | **Not started** | Configuration comes from environment variables. No secret manager or KMS integration |
| SL-092 | Production deployment | **Blocked — N-03** | No hosting target chosen. This machine has no Docker and no admin rights |
| SL-093 | Backup & recovery | **Blocked — N-03** | A restore drill needs an environment to drill against |
| SL-094 | Feature flags | **Partial** | Table exists; **no reader, deliberately** — a flag mechanism with no feature to gate is the "built and unreachable" pattern we have been removing. The security half (flags cannot bypass authorization) is enforced structurally by the boundary law |

## 15. Enterprise Integration

Every item here is the same shape: **the interface exists in `shared-contracts` with a
Local or Mock implementation behind it, and the remote side does not exist.** That is the
design — cutover is a configuration change, not a rewrite — but none of it can be built or
tested until CCS publishes contracts (**N-01**).

| ID | Feature | Status |
|---|---|---|
| SL-095 | CustomerContextProvider | **Blocked — N-01** (interface + local implementation ready) |
| SL-096 | WorkOrchestratorClient | **Blocked — N-01** (interface + Local orchestrator in use today) |
| SL-097 | ConsentEligibilityClient | **Blocked — N-01** (interface + mock, fails closed) |
| SL-098 | Policy / Claim / Booking adapters | **Blocked — N-01** |
| SL-099 | EventPublisher to CY Brain | **Blocked — N-01** (outbox and event catalogue built; publisher is a mock) |
| SL-100 | Business configuration adapter | **Blocked — N-01** (config entities exist locally, seeded and flagged) |

---

## What changed most recently (2026-08-29)

Three golden tests landed — object storage down, AI provider down, notification provider
down — and the AI one **found two defects on the primary customer-service path that every
existing test had missed**:

1. An agent who *claimed* a conversation could not reply to the customer. The ownership
   episode was written; the column the authorization check reads was not.
2. §21.4's arrival states were never written at all, so a real conversation stayed at
   `NEW` — and there is no `new → resolved` transition. **The resolve endpoint was
   unreachable on every conversation the product had actually created.**

Both are fixed. The lesson is recorded in the test strategy: a test that seeds its own
preconditions proves the code downstream of them and nothing about reachability.

## Verification

```
build         31/31 successful
lint          31/31 successful
boundaries    no violations (372 modules, 1,115 dependencies)
boundary law  proven to FAIL on 2 deliberate violations
test:verify   929 tests, 87 files — none skipped, none failed
```
