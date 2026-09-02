# STARLINK_INTEGRATION_CONTRACTS.md

**Status:** PROPOSED — these interfaces are the production contracts. Mock/Local/Remote implementations all satisfy the same interface; the rest of StarLink never knows which is wired.
**Location in code:** interfaces live in `packages/shared-contracts/src/adapters/**`; implementations live in `adapters/<family>/src/{mock,local,remote}/`.

---

## 1. The adapter law (constitutional)

1. **Domain packages depend on interfaces only.** No adapter implementation, provider SDK, HTTP client, or vendor type may be imported by any `packages/*` module. Enforced by dependency-cruiser in CI.
2. **Runtime selection is configuration**: `SL_ADAPTER_<FAMILY>=mock|local|remote` resolved at boot by a NestJS provider factory. Replacing an adapter is a config/deploy change, never a code change outside `adapters/`.
3. **Every adapter is fail-classified.** Each method's failure mode is declared: `FAIL_CLOSED` (deny/refuse — authz, consent), `FAIL_DEGRADED` (feature absent, conversation continues — AI, search, presence), or `FAIL_QUEUED` (retry via job fabric — notifications, channel sends, event publication). This encodes brief §43's invariants at the type level.
4. **Interim implementations carry `authority: 'TEMPORARY_AUTHORITY'`** in their records and their health report, so no one can mistake a local store for canonical truth.
5. **No adapter stores business truth it doesn't own.** Local adapters may persist working state (e.g., the local queue), but every record that mirrors a canonical CCS/HRMS object stores `{canonical_ref, cached_display_context, cached_at, ttl}` — a reference plus display cache, never an authoritative copy.
6. **Idempotency at every boundary.** Inbound webhooks and outbound commands carry idempotency keys; duplicate delivery is absorbed, never re-executed.

Common types used below:

```ts
type UUID = string;                       // UUIDv7
type CanonicalRef = { system: 'CCS' | 'HRMS' | 'IAM' | 'LOCAL'; type: string; id: string };
type Result<T> = { ok: true; value: T } | { ok: false; error: AdapterError };
interface AdapterError { code: string; retryable: boolean; correlationId: string; }
interface HealthReport { status: 'UP' | 'DEGRADED' | 'DOWN'; authority: 'CANONICAL' | 'TEMPORARY_AUTHORITY' | 'MOCK'; detail?: string; }
```

---

## 2. Adapter registry

| Family (`adapters/<dir>`) | Interface(s) | Mock | Local (interim) | Remote (final) | Fail class |
|---|---|---|---|---|---|
| `iam` | IdentityAuthorizationClient | ✅ | PG-backed, TEMPORARY_AUTHORITY | Central IAM | FAIL_CLOSED |
| `employee-directory` | EmployeeDirectoryProvider, HierarchyScopeProvider, DelegationProvider | ✅ | PG-backed | HRMS | FAIL_CLOSED (scope) / DEGRADED (display) |
| `customer-identity` | CustomerIdentityProvider | ✅ | OTP/session local | CCS Customer Graph + auth | FAIL_CLOSED |
| `customer-context` | CustomerContextProvider | ✅ | seeded fake | CCS Customer Graph | FAIL_DEGRADED |
| `work-orchestrator` | WorkOrchestratorClient | ✅ | **LocalWorkOrchestratorAdapter** (full §21.8 tree) | CCS Work Orchestrator | FAIL_QUEUED (routing) / FAIL_CLOSED (claim conflicts) |
| `consent` | ConsentEligibilityClient | ✅ (permissive dev / strict test) | policy-file local | CCS Consent & Contact Governance | **FAIL_CLOSED** for outbound |
| `notification-provider` | NotificationTransport (per channel) | ✅ | console/mailhog | SES/FCM/provider | FAIL_QUEUED |
| `object-storage` | ObjectStorageProvider | in-memory | MinIO | S3-compatible | FAIL_DEGRADED (attachments only) |
| `search` | SearchProvider | in-memory | PG FTS | OpenSearch-class | FAIL_DEGRADED |
| `ai` | AIProvider (capability-sliced) | canned | — | Claude API (`claude-sonnet-5` default; see ADR note) | FAIL_DEGRADED |
| `event-bus` | EventPublisher, EventSubscriber | in-memory | PG topic table + relay | CCS Event Fabric | FAIL_QUEUED |
| `telephony` | TelephonyLinkAdapter | ✅ | — | provider TBD | FAIL_DEGRADED |
| `whatsapp` | ChannelAdapter | ✅ | — | BSP TBD (D-01) | FAIL_QUEUED |
| `email` | ChannelAdapter | ✅ | mailhog | provider TBD | FAIL_QUEUED |
| CCS business objects | Opportunity/Policy/Claim/Booking/PaymentContextProvider | ✅ | seeded fake | CCS PRO | FAIL_DEGRADED (read) / FAIL_CLOSED (link-create) |

---

## 3. Identity & authorization (employee side)

```ts
/** Answers "who is this principal and what may they do" — Central IAM is the eventual authority. */
export interface IdentityAuthorizationClient {
  resolvePrincipal(principalId: UUID): Promise<Result<PrincipalClaims>>;
  verifyCredential(username: string, secret: string): Promise<Result<{ principalId: UUID }>>; // Local only; Remote delegates to IAM/SSO
  getSessionVersion(principalId: UUID): Promise<Result<number>>;
  revokeSessions(principalId: UUID, reason: string): Promise<Result<void>>;      // bumps version; gateway closes sockets
  health(): Promise<HealthReport>;
}

export interface PrincipalClaims {
  principalId: UUID;
  employeeId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'EXITED';
  roles: RoleAssignment[];                 // role + scope + effective dates
  teams: TeamRef[];
  department: string; branch?: string;
  managerChain: UUID[];                    // reporting hierarchy, nearest first
  skills: string[]; products: string[]; languages: string[];
  delegations: Delegation[];               // received temporary delegations
  privilegedCapabilities: string[];        // e.g. 'compliance.audit.read', 'pii.unmask'
  effectiveFrom: string; effectiveTo?: string;
  authority: 'CANONICAL' | 'TEMPORARY_AUTHORITY';
}

export interface EmployeeDirectoryProvider {
  getEmployee(principalId: UUID): Promise<Result<EmployeeDisplay>>;
  searchDirectory(query: string, scope: DirectoryScope, cursor?: string): Promise<Result<Page<EmployeeDisplay>>>;
  listTeamMembers(teamId: string): Promise<Result<EmployeeDisplay[]>>;
  health(): Promise<HealthReport>;
}

export interface HierarchyScopeProvider {
  resolveScope(principalId: UUID): Promise<Result<HierarchyScope>>;   // teams/departments/branches this principal's roles cover
  isWithinScope(actor: UUID, subject: UUID): Promise<Result<boolean>>;
}

export interface DelegationProvider {
  activeDelegations(principalId: UUID): Promise<Result<Delegation[]>>;
  grant(d: DelegationRequest): Promise<Result<Delegation>>;           // audited; time-boxed mandatory
  revoke(delegationId: UUID, reason: string): Promise<Result<void>>;
}
```

**Employee-exit contract (all implementations MUST honour, tested in the golden suite):** setting status `EXITED` ⇒ `revokeSessions` fires, gateway closes sockets, Work Orchestrator stops offering assignments, and `conversation-domain` surfaces every owned conversation for reassignment. History and authorship remain immutable (brief §49).

---

## 4. Customer identity

```ts
export type Assurance = 'ANONYMOUS' | 'PSEUDONYMOUS' | 'VERIFIED_CUSTOMER' | 'AUTHENTICATED_CUSTOMER';

export interface CustomerIdentityProvider {
  createSession(channel: ChannelKind, hints?: IdentityHints): Promise<Result<CustomerSession>>;   // starts ANONYMOUS/PSEUDONYMOUS
  beginVerification(sessionId: UUID, method: 'OTP_MOBILE' | 'OTP_EMAIL' | 'POLICY_LOOKUP' | 'AUTH_PORTAL'): Promise<Result<VerificationChallenge>>;
  completeVerification(sessionId: UUID, challengeId: UUID, proof: string): Promise<Result<CustomerSession>>; // raises assurance; audited
  resolveCustomer(sessionId: UUID): Promise<Result<{ customerRef: CanonicalRef; assurance: Assurance } | null>>;
  invalidate(sessionId: UUID): Promise<Result<void>>;
  health(): Promise<HealthReport>;
}
```

Rules: assurance is monotonic per verified identity claim; a *different* identity claim never inherits prior history (§27.3); required assurance is declared per action class (ADR-019); OTP attempts are rate-limited and audited.

---

## 5. CCS business-object context providers (read + link, never own)

All six share one shape — read canonical context for display/routing, and register conversation links. StarLink never mutates the objects.

```ts
export interface CustomerContextProvider {
  getCustomer360(customerRef: CanonicalRef, purpose: string, actor: UUID): Promise<Result<Customer360Summary>>; // purpose-bound; masked by default
  findByIdentity(claim: { mobile?: string; email?: string; policyNo?: string }): Promise<Result<CanonicalRef[]>>;
  getRelationshipOwner(customerRef: CanonicalRef): Promise<Result<{ principalId: UUID } | null>>;               // designated RM (D-19)
  health(): Promise<HealthReport>;
}

export interface OpportunityProvider {
  getActiveForCustomer(customerRef: CanonicalRef): Promise<Result<BusinessObjectSummary[]>>;
  proposeCreate(req: OpportunityDraft, origin: { conversationId: UUID; messageId?: UUID }): Promise<Result<CanonicalRef>>; // CCS decides
}
// PolicyContextProvider, ClaimContextProvider, BookingContextProvider, PaymentContextProvider: same pattern —
//   getSummary(ref, purpose, actor)  → sensitivity-filtered display context
//   listForCustomer(customerRef)     → refs + classifications only
//   linkConversation(ref, conversationId, relation) → back-reference registered in CCS (or Local ledger)
```

`BusinessObjectSummary` = `{ ref, type, displayLabel, status, sensitivity, cached_at }`. Cached display context obeys rule 5 (§1) — reference + cache, TTL-bound, refreshable, never authoritative.

---

## 6. WorkOrchestratorClient — the routing authority seam

```ts
export interface WorkOrchestratorClient {
  /** Submit routing context; returns a decision. Async-safe: QUEUED is a first-class success. */
  requestRouting(ctx: RoutingContext): Promise<Result<RoutingDecision>>;
  /** Atomic claim of queued work. Exactly one winner; losers get { outcome:'ALREADY_ASSIGNED' }. */
  claim(queueEntryId: UUID, principalId: UUID, idempotencyKey: string): Promise<Result<ClaimOutcome>>;
  /** Atomic capacity reservation with TTL (Part IV §55). */
  reserve(principalId: UUID, workRef: CanonicalRef, weight: number, ttlSec: number): Promise<Result<Reservation>>;
  release(reservationId: UUID, reason: string): Promise<Result<void>>;
  transfer(req: TransferRequest): Promise<Result<void>>;             // reason mandatory; audited
  escalate(req: EscalationRequest): Promise<Result<void>>;           // level raise; audited
  reportAgentState(principalId: UUID, state: AgentWorkState): Promise<Result<void>>;
  queueSnapshot(teamId: string): Promise<Result<QueueMetrics>>;      // depth, oldest age, by intent/priority
  health(): Promise<HealthReport>;
}

export interface RoutingContext {
  conversationId: UUID; caseId?: UUID;
  intent: { category: string; subCategory?: string };
  product?: string; language?: string; priority?: string;
  customerRef?: CanonicalRef; relationshipOwner?: UUID;
  activeBusinessObjects?: CanonicalRef[];
  channel: ChannelKind; sensitivity?: string;
  slaTargetRef?: string; businessHoursState: 'OPEN' | 'AFTER_HOURS';
  requiredSkills?: string[];
}
export type RoutingDecision =
  | { outcome: 'ASSIGNED'; principalId: UUID; reservationId: UUID; reason: string }
  | { outcome: 'QUEUED'; queueEntryId: UUID; queuePosition?: number; reason: string }
  | { outcome: 'DEFERRED_AFTER_HOURS'; queueEntryId: UUID };
```

**LocalWorkOrchestratorAdapter** (Phase 5) implements the full §21.8 decision tree + §23 calendars + weighted capacity (ADR-023) over PG (`SELECT … FOR UPDATE SKIP LOCKED` claims). It is the *reference semantics* for the eventual CCS Remote adapter; its rule config is data, not code. When CCS Work Orchestrator arrives, StarLink keeps only inbox/queue display + context submission (Part IV §48).

---

## 7. ConsentEligibilityClient — checked at execution time, always

```ts
export interface ConsentEligibilityClient {
  /** MUST be called immediately before any outbound/proactive customer contact (Part IV §58). */
  checkOutbound(req: { customerRef: CanonicalRef; channel: ChannelKind; purpose: string; templateRef?: string }): Promise<Result<Eligibility>>;
  checkReEngagement(req: { conversationId: UUID; channel: ChannelKind; purpose: string }): Promise<Result<Eligibility>>;
  health(): Promise<HealthReport>;
}
export type Eligibility = { allowed: true; constraints?: string[] } | { allowed: false; reason: string };
```

FAIL_CLOSED: if the client cannot answer, **no new proactive outbound is sent**; inbound servicing continues per explicit fail-safe policy (Part IV §62). Channel availability is never permission.

---

## 8. Notifications

```ts
export interface NotificationClient {           // domain-facing; writes NotificationOutbox rows (P-05)
  enqueue(n: NotificationRequest): Promise<Result<{ outboxId: UUID }>>;
}
export interface NotificationTransport {        // per-channel adapter consumed by workers
  channel: 'INAPP' | 'EMAIL' | 'PUSH' | 'WHATSAPP' | 'SMS';
  deliver(payload: RenderedNotification, idempotencyKey: string): Promise<Result<'DELIVERED' | 'RETRYABLE' | 'PERMANENT_FAILURE'>>;
  health(): Promise<HealthReport>;
}
```

Dedupe on `(recipient, event, target)` window; coalescing ("3 new messages"); suppression when the recipient is actively viewing the conversation (policy-driven); customer-channel sends re-check consent (§7). Outbox states: `pending → processing → sent | retrying → dead_letter` with alerting on depth/DLQ.

---

## 9. ChannelAdapter — one contract for every external channel

```ts
export interface ChannelAdapter {
  channel: ChannelKind;   // 'WEBSITE' | 'APP' | 'WHATSAPP' | 'EMAIL' | 'SMS' | 'VOICE_LINK' | 'PUSH'
  send(msg: OutboundChannelMessage, idempotencyKey: string): Promise<Result<ProviderAccept>>;   // rejects non-CUSTOMER_VISIBLE by type
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): Promise<Result<boolean>>;
  receiveWebhook(envelope: VerifiedWebhook): Promise<Result<InboundChannelEvent[]>>;             // normalises to Conversation commands
  mapExternalIdentity(e: ExternalIdentity): Promise<Result<{ bindingHint: ChannelBindingHint }>>;
  mapDeliveryStatus(providerEvent: unknown): Promise<Result<DeliveryStatusUpdate>>;              // ACCEPTED|DELIVERED|READ|FAILED|UNKNOWN|SUPERSEDED
  downloadMedia(ref: ProviderMediaRef): Promise<Result<QuarantineUploadTicket>>;                 // media goes through the §59 pipeline
  reconcile(since: string): Promise<Result<ReconciliationReport>>;                               // heals UNKNOWNs
  health(): Promise<HealthReport>;
}
```

Rules: canonical Conversation + `ChannelSession`/`ConversationChannelBinding` keep one business thread across channels (Part IV §49); duplicate webhooks absorbed idempotently; `UNKNOWN` delivery triggers reconciliation, never optimistic success; channel switching records a HANDOFF event with continuity token; no silent channel hopping (consent-gated).

---

## 10. EventPublisher + versioned event catalogue

```ts
export interface EventPublisher {
  publish(events: DomainEventEnvelope[]): Promise<Result<void>>;   // called ONLY by the outbox relay
  health(): Promise<HealthReport>;
}
```

**Catalogue v1** (Zod schemas in `packages/shared-contracts/src/events/`; envelope per ADR-013; payloads = IDs + classifications, never bodies/PII):

| Event | Key payload fields |
|---|---|
| `conversation.created.v1` | conversation_id, type, channel, customer_ref?, case_id?, category |
| `conversation.assigned.v1` | conversation_id, case_id, owner_principal, assignment_source, reservation_id |
| `conversation.reassigned.v1` | conversation_id, previous_owner, next_owner, reason_code |
| `conversation.transferred.v1` | conversation_id, from, to, reason_code, actor |
| `conversation.escalated.v1` | conversation_id, case_id, from_level, to_level, reason_code, actor |
| `conversation.resolved.v1` | conversation_id, case_id, outcome_code, actor |
| `conversation.closed.v1` / `conversation.reopened.v1` | conversation_id, case_id, trigger |
| `message.created.v1` | message_id, conversation_id, seq, sender_kind, visibility, channel, has_attachments |
| `message.read.v1` | conversation_id, principal_ref, up_to_seq |
| `customer.reply.received.v1` | conversation_id, case_id, channel, waiting_state_cleared |
| `attachment.ready.v1` | attachment_id, conversation_id, scan_verdict, classification |
| `conversation.sla.at_risk.v1` / `conversation.sla.breached.v1` | case_id, clock, elapsed_pct/breach_at, team |
| `conversation.queue.threshold.v1` | team, depth, oldest_age, threshold |
| `employee.deactivated.v1` | principal_id, owned_open_conversations, reassignment_status |
| `ai.handoff.completed.v1` | conversation_id, summary_ref, confidence, reason |

Compatibility: additive-only within v1; breaking ⇒ `v2` dual-published through a deprecation window (brief §58).

---

## 11. Storage, search, AI

```ts
export interface ObjectStorageProvider {
  issueUploadGrant(req: { conversationId: UUID; declaredMime: string; declaredBytes: number; purpose: string }): Promise<Result<{ url: string; key: string; expiresAt: string }>>; // → quarantine prefix
  promote(key: string): Promise<Result<{ cleanKey: string }>>;
  issueDownloadGrant(cleanKey: string, ttlSec: number): Promise<Result<{ url: string }>>;   // issued only after full authz ladder; issuance audited
  delete(key: string): Promise<Result<void>>;
  health(): Promise<HealthReport>;
}

export interface SearchProvider {
  index(doc: SearchDocument): Promise<Result<void>>;                       // via search-index queue
  search(scope: AuthorizedScope, q: string, cursor?: string): Promise<Result<Page<SearchHit>>>;  // scope is a required parameter — unscoped search is uncompilable
  remove(docId: UUID): Promise<Result<void>>;                              // retention/erasure propagation
  rebuild(range?: DateRange): AsyncIterable<RebuildProgress>;
  health(): Promise<HealthReport>;
}

export interface AIProvider {   // capability-sliced; every call returns advisory output with provenance
  classifyIntent(input: RedactedTranscriptRef): Promise<Result<Advisory<IntentClassification>>>;
  summarise(kind: 'HANDOFF' | 'THREAD' | 'QUEUE', ref: RedactedTranscriptRef): Promise<Result<Advisory<Summary>>>;
  draftReply(ctx: PermittedContextRef): Promise<Result<Advisory<Draft>>>;
  answerFromKnowledge(q: string, corpus: 'PUBLIC' | 'AUTHORIZED'): Promise<Result<Advisory<GroundedAnswer>>>; // RAG, citations mandatory
  assessRisk(kind: 'MIS_SELLING' | 'DLP' | 'SENTIMENT' | 'URGENCY', ref: RedactedTranscriptRef): Promise<Result<Advisory<RiskSignal>>>;
  extractActions(ref: RedactedTranscriptRef): Promise<Result<Advisory<ActionItem[]>>>;
  health(): Promise<HealthReport>;
}
export interface Advisory<T> { value: T; model: string; promptVersion: string; confidence: number; evidenceRefs: string[]; generatedAt: string; }
```

AI rules (brief §36): advisory only; never decides identity/consent/routing-hard-constraints/authorization/payment/claim/policy state; bounded to permitted context (redaction happens *before* the provider boundary); outputs stored with model+version+evidence; human fallback must work with AI fully disabled (Part IV §68 gate 9).

---

## 12. HRMS / Central IAM cutover plan (written now, executed Phase 9)

1. **Today (Phases 2–8):** `LocalIamAdapter` + local directory tables, every record stamped `TEMPORARY_AUTHORITY`. Claim shape identical to §3. Admin console manages accounts *through the adapter interface*.
2. **Shadow phase:** Remote IAM adapter deployed read-only alongside Local; a reconciliation job diffs claims (principal by principal) and reports drift. No behaviour change.
3. **Cutover:** `SL_ADAPTER_IAM=remote`. Local tables become a frozen projection (read-only cache for display names of exited historical actors). Session issuance now validates against IAM; session-version bump forces universal re-auth at the cutover moment.
4. **Contract guarantees that make this safe:** principal_id is minted as the stable join key from day one and is carried into HRMS mapping (HRMS employee_id ↔ StarLink principal_id mapping table, owned by the adapter); authorship/ownership history references principal_id and is never rewritten (brief §49).
5. **Rollback:** flip config back; sessions re-issue. No schema change in either direction.

## 13. CY Brain integration path

- **Direction: outbound only, async only.** CY Brain consumes the §10 event catalogue plus periodic projections (`queue pressure`, `capacity`, `SLA risk`, `intent trends`, `channel health`, `AI risk signals`) published via `EventPublisher` / metrics endpoints.
- **Never synchronous, never required**: no live message send/read path calls CY Brain; Brain outage degrades dashboards only (Part IV §62). Events retry through the outbox.
- **Content policy:** classifications and counts, never message bodies (brief §47).

## 14. Versioning & compatibility

REST: `/v1` path version, additive-preferred. Events: per-catalogue rule (§10). Adapter interfaces: semver in `shared-contracts`; a breaking interface change requires simultaneous release of all in-repo implementations (monorepo makes this atomic). Webhooks: provider-versioned, verified, replay-protected. AI prompts: `promptVersion` recorded on every advisory. Schema: expand→migrate→contract only.
