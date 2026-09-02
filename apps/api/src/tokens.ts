/**
 * Dependency-injection tokens.
 *
 * Every dependency the app resolves is named by a token rather than by a concrete
 * class. That is the mechanism behind "replacing an adapter is a configuration change,
 * never a code change outside adapters/" (INTEGRATION_CONTRACTS §1 rule 2): a
 * controller asks for `IDENTITY_CLIENT`, and whether that is the mock, the interim
 * PostgreSQL adapter or Central IAM is decided once, in the composition root.
 */
export const CONFIG = Symbol('SL_CONFIG');
export const LOGGER = Symbol('SL_LOGGER');
export const DATABASE = Symbol('SL_DATABASE');

export const IDENTITY_CLIENT = Symbol('SL_IDENTITY_CLIENT');
export const SESSION_SERVICE = Symbol('SL_SESSION_SERVICE');
export const CURSOR_CODEC = Symbol('SL_CURSOR_CODEC');
export const CONVERSATION_LIST_CURSOR_CODEC = Symbol('SL_CONVERSATION_LIST_CURSOR_CODEC');

export const MESSAGE_STORE = Symbol('SL_MESSAGE_STORE');
export const MESSAGE_READER = Symbol('SL_MESSAGE_READER');
export const REACTION_STORE = Symbol('SL_REACTION_STORE');
export const CONVERSATION_STORE = Symbol('SL_CONVERSATION_STORE');
export const CONVERSATION_READER = Symbol('SL_CONVERSATION_READER');
export const READ_STATE_STORE = Symbol('SL_READ_STATE_STORE');
export const EMPLOYEE_DIRECTORY = Symbol('SL_EMPLOYEE_DIRECTORY');
export const CUSTOMER_IDENTITY = Symbol('SL_CUSTOMER_IDENTITY');
export const CUSTOMER_STORE = Symbol('SL_CUSTOMER_STORE');
export const CATEGORY_READER = Symbol('SL_CATEGORY_READER');
export const SEARCH_PROVIDER = Symbol('SL_SEARCH_PROVIDER');
export const SEARCH_RATE_LIMITER = Symbol('SL_SEARCH_RATE_LIMITER');
export const ROUTING_STORE = Symbol('SL_ROUTING_STORE');
/** SL-083: one grouped read of a team's waiting work, ownership, SLA and capacity. */
export const TEAM_LOAD_READER = Symbol('SL_TEAM_LOAD_READER');
export const CASE_STORE = Symbol('SL_CASE_STORE');
export const AI_PROVIDER = Symbol('SL_AI_PROVIDER');
export const AUTHZ_READER = Symbol('SL_AUTHZ_READER');
export const ADMIN_STORE = Symbol('SL_ADMIN_STORE');
export const AUDIT_WRITER = Symbol('SL_AUDIT_WRITER');
export const CALENDAR_READER = Symbol('SL_CALENDAR_READER');
export const AVAILABILITY_READER = Symbol('SL_AVAILABILITY_READER');
export const WORK_ORCHESTRATOR = Symbol('SL_WORK_ORCHESTRATOR');
export const CATEGORY_ROUTING_CONFIG = Symbol('SL_CATEGORY_ROUTING_CONFIG');
export const SLA_READER = Symbol('SL_SLA_READER');
export const ATTACHMENT_STORE = Symbol('SL_ATTACHMENT_STORE');
export const OBJECT_STORAGE = Symbol('SL_OBJECT_STORAGE');
export const ATTACHMENT_SCANNER = Symbol('SL_ATTACHMENT_SCANNER');
export const NOTIFICATION_OUTBOX = Symbol('SL_NOTIFICATION_OUTBOX');
export const NOTIFICATION_TRANSPORTS = Symbol('SL_NOTIFICATION_TRANSPORTS');
export const NOTIFICATION_RECIPIENTS = Symbol('SL_NOTIFICATION_RECIPIENTS');
export const NOTIFICATION_PREFERENCES = Symbol('SL_NOTIFICATION_PREFERENCES');
