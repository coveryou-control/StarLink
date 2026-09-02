# CURRENT_STATE_AUDIT.md

**Project:** StarLink — CoverYou Conversation OS
**Date:** 2026-08-24
**Author:** Principal Engineering (implementation phase)
**Status:** PHASE 0 DELIVERABLE — no production code exists or has been written

---

## 1. Repository inventory

| Item | Finding |
|---|---|
| Path | `c:\Starlink` |
| Git repository | **No** — not initialised |
| Code | **None.** Zero source files, zero configuration, zero infrastructure definitions |
| CI/CD | None |
| Contents | `StarLink-Solution-Architecture-v2.2_CCS_CYBRAIN_PRODUCTION_SCALE_UPDATED.docx` (203 KB) and the equivalent `.pdf` (3.8 MB) — identical content, ~68 sections across four parts |

**Conclusion: this is a greenfield implementation.** There is no legacy code to audit, refactor, or preserve. The earlier evaluation prototype referenced in §14.3 of the document (Python/FastAPI + React/Vite) is *not present in this repository* and the document itself states its code does not carry forward — only two findings do (the independence guard-test pattern, and the participation-is-not-authorization lesson).

The audit therefore covers three things:
1. What the v2.2 document actually specifies (including where Part IV supersedes the v2.1 body).
2. Conflicts between the document and the implementation brief (the operative instruction set).
3. What is reusable, what is missing, and what must be built.

---

## 2. Architecture document analysis

### 2.1 Document structure and precedence

The v2.2 document is **two documents in one**, and this matters enormously for implementation:

- **Sections 1–46 (the v2.1 body):** a self-contained, standalone StarLink — MongoDB, no Redis in V1, no broker, in-process realtime and workers, StarLink-owned identity, StarLink-owned audit, single deployable.
- **Sections 47–68 (Part IV, v2.2 additions):** the CCS PRO / CY Brain alignment layer, with an explicit **precedence rule**: *"Where a v2.1 statement conflicts with CCS PRO canonical ownership, CY Brain constitutional boundaries, privacy controls, or the production-scale requirements below, Part IV governs StarLink."*

**Any implementation that follows sections 1–46 literally will be wrong.** Part IV §67 explicitly supersedes eight v2.1 positions:

| v2.1 body said | Part IV (governing) says |
|---|---|
| Redis deferred until multi-instance trigger (§14.2, §23.9, §33.2) | Redis-compatible backplane/counters are **baseline for V1-B production** and the 500+ concurrent acceptance envelope (§52, §67) |
| No message broker; DB outbox only (§29.4, T-13) | Durable managed **async queue/job fabric is baseline** for notifications, webhooks, AI, indexing, media (§52, §67). No Kafka requirement |
| StarLink identity store is V1 source of record (§17.2, T-09/T-21) | **Superseded for enterprise rollout.** Central IAM is authority; StarLink holds only a bootstrap/dev projection behind a provider contract until IAM cutover (§48, §67) |
| StarLink audit store is the complete audit (§31) | Local audit exists for deployment independence, but enterprise security/business events **publish to the CCS Event/Audit contract**; no competing compliance truth (§48, §67) |
| Exactly one owner per conversation (BR-10) | Kept as **UX projection**; executable responsibility belongs to canonical Work/Case ownership via Work Orchestrator (§48, §67) |
| No runtime dependency on any internal platform (O-09) | Clarified: no **NorthStar/peer-app** dependency. CCS kernel services are intentional dependencies; CY Brain never required for transaction correctness (§67) |
| Attachments stream through the application (§28.4, ADR-08) | **Pre-signed direct upload/download** with quarantine → scan → promote pipeline; app nodes never proxy full files by default (§59, §52) |
| Website chat is the primary customer channel (§21) | Channel-neutral architecture; Website/App/WhatsApp/Email/Voice continuity via ChannelSessions (§49, §56, §67) |

### 2.2 What the document gets right and we adopt unchanged

These are the load-bearing invariants, consistent across v2.1, Part IV, and the implementation brief. They are adopted verbatim:

1. **Persist-before-publish / durability-before-delivery** (P-05, §53) — a message is acknowledged only after durable storage; everything after commit is best-effort.
2. **Realtime is additive** (FR-RT-1, §20.3) — no state exists only in an event; recovery is re-fetch, never replay; events carry IDs, not bodies.
3. **Authorization before content on every path** (FR-AUTHZ-1, §18.4) — the four-layer check: edge guard → route guard → **object check** → field filter (defence in depth, never the boundary).
4. **Participation ≠ ownership ≠ authentication ≠ authorization** (§27.9) — the four-concept separation; participation grants exactly one conversation.
5. **Internal notes are schema-enforced staff-only** (BR-24..27, §49, §58) — fail-closed send if the marker cannot be established; customer serialisers are allow-lists; external adapters reject non-customer-deliverable visibility classes.
6. **Ownership episodes are append-only temporal records** (BR-14, §49) — current owner is a projection; history is immutable; authorship is never rewritten.
7. **Transfer/escalation are events, not states; escalation is a level** (K-02, §21.4).
8. **One Service Case, many Conversations** (§22.4) — SLA clocks and escalation history live on the case, and are deliberately *not* denormalised onto the conversation.
9. **Scope-before-query search** (§30.2, §60) — never global-search-then-filter.
10. **Cursor pagination with (created_at, id) tiebreak, signed opaque cursors, never offset** (FR-MSG-3/4, §38's measured 301-vs-20,000 documents-examined result).
11. **Atomic claim — exactly one winner** (FR-ROUTE-3, §44 of brief).
12. **Audit split: append-only ledger + separately-retained request context** (§31.4) — retention and immutability both satisfiable.
13. **Availability is declared/derived, never inferred from a socket** (§21.9, rule 23 of §46).
14. **SLA clocks computed on read from versioned business calendars, never accumulated by jobs** (NFR-PRF-7, §23.5). No SLA values invented in code.
15. **Inactive-owner conversations = 0** as an alerting invariant (§32.3/32.4).
16. **The 24 "rules that must not be traded away"** (§46) — carried into the test strategy as property tests.

### 2.3 Internal inconsistencies found in the document

Small, and all resolvable in Part IV's favour or by the implementation brief:

| # | Inconsistency | Resolution adopted |
|---|---|---|
| I-1 | §28.4/ADR-08 (bytes stream through app; signed URLs rejected for V1) vs §59 (pre-signed URLs, direct-to-storage, app never proxies) | **§59 governs** (Part IV precedence). Download audit is preserved by auditing *authorized issuance* of the short-lived URL, which §28.4 itself concedes is acceptable when all checks precede issuance |
| I-2 | §22.3/21.4 state machine has a single `waiting` state vs brief §24 requiring `WAITING_CUSTOMER` and `WAITING_INTERNAL` | **Brief governs** — two waiting states (the split changes SLA pause semantics: waiting-on-customer pauses the resolution clock; waiting-internal does not) |
| I-3 | §18.6 in-process scheduled workers vs §52 dedicated worker fleet on the job fabric | **§52 governs** — `apps/workers` from Phase 1; idempotent jobs with distributed claim (the §18.6 caveat already anticipated this) |
| I-4 | T-06/ADR-03 "MongoDB PROPOSED" presented near-final vs §52 "MongoDB remains acceptable **if benchmarks pass**" vs brief §32 "do not blindly retain MongoDB; evaluate and document in ADR" | **Evaluated fresh.** Decision and full reasoning in STARLINK_ARCHITECTURE_DECISIONS.md ADR-001 (PostgreSQL recommended) |
| I-5 | §28.2 "no malware scanning for employee uploads in V1-A (deliberate gap)" vs §59 pipeline (all uploads quarantined and scanned) and brief §28 | **§59/brief govern** — one pipeline for all uploads; the scan adapter may be a permissive local stub in dev, but the quarantine→scan→promote state machine exists from the first upload |
| I-6 | §20.6 "one connection per authenticated browser tab" vs §64 per-user/device connection limits | Not a conflict — per-principal connection ceilings are configuration (SL_RT_MAX_CONN_PER_PRINCIPAL) |
| I-7 | v2.1 conversation types (internal 1:1/group/announcement/customer) vs brief §5's ten types | **Brief governs** — the ten-type enum plus configurable metadata; v2.1's four map onto it |

### 2.4 Conflicts between the document and the implementation brief

The brief is effectively a v2.3 directive. Where it tightens the document, the brief wins:

| # | Topic | Document (incl. Part IV) | Brief | Adopted |
|---|---|---|---|---|
| C-1 | Repository shape | One repo, one deployable + Next.js builds | Modular monorepo: `apps/` (employee-web, customer-web, api, realtime-gateway, workers), `packages/`, `adapters/`, `infrastructure/` | **Brief.** The doc's module-boundary intent (§18) maps 1:1 onto workspace packages; boundaries become physically enforced by package imports + lint rules, stronger than the doc's build-time test |
| C-2 | Database | MongoDB proposed, benchmark-gated | Evaluate MongoDB/PostgreSQL/hybrid against outbox, ownership history, authz reads, audit | **PostgreSQL** (ADR-001) — the transactional outbox, atomic claim, temporal ownership and idempotency requirements all favour ACID multi-row transactions; every Mongo advantage cited in ADR-03 is reproducible in PG (JSONB message variation, composite-index paging) |
| C-3 | Identity | Central IAM authority "for enterprise rollout"; StarLink store until cutover | `IdentityAuthorizationClient` + directory/hierarchy/delegation providers behind final production interfaces from day one; interim records marked `TEMPORARY_AUTHORITY` | **Brief** — the interim store exists only behind the adapter interface; nothing outside `adapters/iam` knows it exists |
| C-4 | Routing authority | Work Orchestrator canonical (Part IV) | `WorkOrchestratorClient` with `LocalWorkOrchestratorAdapter` matching the final interface | **Aligned** — brief operationalises Part IV |
| C-5 | Conversation types | 4 types + case categories | 10 explicit types incl. SYSTEM_INTERACTION, AI_HANDOFF | **Brief** |
| C-6 | Customer identity levels | verified session (D-02 proposed) | ANONYMOUS / PSEUDONYMOUS / VERIFIED_CUSTOMER / AUTHENTICATED_CUSTOMER with action-dependent assurance | **Brief** — strictly more general; D-02 becomes the *verification method* within this ladder |
| C-7 | Scale targets | 500 employees + 1,500 customers + 2,000 sockets + 100 msg/s + 10M messages (§54) | Same numbers | **Identical** — no conflict |
| C-8 | Drafts | Client-only, browser (UC-C05) | Client-side autosave, IndexedDB, scoped by conversation/principal/device | **Aligned** |
| C-9 | AI | Part IV §57 capabilities | Brief §36/37 same list + advisory/traceable/versioned rules | **Aligned** |
| C-10 | Backpressure | §51.9 admission control, §62 degradation | Brief §19 P0/P1/P2 priority classes | **Brief's priority classes adopted** as the concrete policy |

**No conflict requires escalation.** Every divergence resolves cleanly by the precedence chain: implementation brief > Part IV > v2.1 body.

---

## 3. What is reusable

Since there is no code, "reusable" means specification assets:

| Asset | Reuse |
|---|---|
| Domain rules BR-01..BR-32, principles P-01..P-08, rules §46.1–24 | Directly encoded as domain invariants + property tests |
| FR/NFR catalogues (§10, §13) | Traceability targets for the test strategy |
| State machine (§21.4, amended per I-2) and transition/event tables | Direct implementation in `packages/service-case` |
| Routing decision tree (§21.8) and availability semantics (§21.9) | `LocalWorkOrchestratorAdapter` specification |
| Case/conversation split and denormalisation lists (§22.4, §24.14) | Schema design input (denormalisation list re-evaluated for PG — most rows become unnecessary because joins exist; see ADR-001) |
| Index intent (§24.7, §24.13, brief §33) | Migration 0001+ index plan |
| Event tables (§20.7) — publisher/receiver/authz/ordering/idempotency per event | Realtime gateway specification |
| Customer-forbidden list (§11.7), customer API surface (§25.3) | Customer API allow-list + isolation property tests |
| Audit taxonomy (§31.1/31.2) | `packages/audit` event vocabulary |
| Decision register D-01..D-29 (§44) | Carried into STARLINK_OPEN_QUESTIONS.md with implementation-blocking status re-assessed |
| NorthStar lessons (§38) | KEEP/IMPROVE/REJECT verdicts encoded (signed cursors, no `everyone` flag, session-version revocation, sockets die with sessions) |
| Part IV §65 test lab + §68 acceptance gates | Backbone of STARLINK_TEST_STRATEGY.md |

---

## 4. What is missing (must be built — everything)

| Layer | Missing |
|---|---|
| Repository | Monorepo scaffold, workspace config, lint/boundary enforcement, CI |
| Domain | All packages: conversation-domain, messaging, routing, service-case, presence, attachments, notifications, audit, search, sla, shared-contracts, observability, ai-assist |
| Apps | api, realtime-gateway, workers, employee-web, customer-web |
| Adapters | All 14+ adapter families (iam, employee-directory, customer-context, work-orchestrator, consent, customer-identity, notification-provider, object-storage, search, ai, event-bus, telephony, whatsapp, email) — each with Mock/Local/Remote slots |
| Infrastructure | docker-compose, PostgreSQL, Redis, object storage (MinIO dev), migrations tooling, seed data, monitoring stack |
| Contracts | Event schemas (versioned), API contracts, adapter interfaces |
| Tests | Everything in STARLINK_TEST_STRATEGY.md |
| Load lab | k6/Artillery suite for the §54 envelope |

---

## 5. External unknowns that shape the build (not blockers for Phases 1–3)

| Unknown | Impact | Mitigation |
|---|---|---|
| CCS PRO API specs do not exist yet (no schema/OpenAPI available in this repo) | Remote adapters cannot be finalised | Interfaces frozen from the brief's contract list; Local/Mock implementations first; Remote in Phases 9–10 |
| HRMS/Central IAM timeline unknown | Interim identity duration unknown | `TEMPORARY_AUTHORITY` marking + cutover plan written now (see STARLINK_INTEGRATION_CONTRACTS.md §2) |
| Hosting/cloud not settled (T-17 OPEN) | Managed-service choices (queue, Redis, object storage, KMS) unresolved | All infra behind drivers; dev uses containers; production drivers selected at Phase 12 hardening |
| D-01 customer channel undecided | WhatsApp adapter build order | Channel adapters are Phase 8+; website chat (approved) proceeds |
| Business config values (D-17..D-26: categories, hours, SLA targets, thresholds) | Cannot be invented (§46 rule 20) | Config schema + admin seams built; **seed data clearly marked FAKE/DEV**; values are business sign-off items in STARLINK_OPEN_QUESTIONS.md |

---

## 6. Audit verdict

The v2.2 document (Part IV governing) and the implementation brief are **mutually consistent after the reconciliations in §2.3–2.4 above**, all of which are recorded as ADRs. There is no architectural contradiction that blocks Phase 1. The blocking items are exclusively **business decisions** (see STARLINK_OPEN_QUESTIONS.md) and none of them blocks the repository foundation, domain model, internal chat, or realtime phases — exactly as the document's own phasing intends.

**Recommendation: proceed to Phase 1 (repository foundation) upon approval of the plan, with the decision register circulated to business owners in parallel.**
