-- =====================================================================================
-- StarLink migration 0002 — least-privilege roles and audit immutability
--
-- Doc §31.5 wished for database-level enforcement of the append-only ledger, noting
-- that immutability resting on application code alone is a promise rather than a
-- property. This migration makes it a property: the application role is granted
-- INSERT and SELECT on the ledger and nothing else, so an UPDATE or DELETE fails at
-- the database even if application code asks for one.
--
-- Roles created here are NOLOGIN group roles. Deployment grants real users membership
-- (passwords never appear in migrations — brief §42, doc §27.14).
-- =====================================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'starlink_app') THEN
    CREATE ROLE starlink_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'starlink_audit_reader') THEN
    CREATE ROLE starlink_audit_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'starlink_migrator') THEN
    CREATE ROLE starlink_migrator NOLOGIN;
  END IF;
END
$$;

-- ---------------------------------------------------------------- application role
GRANT USAGE ON SCHEMA identity, conversation, audit TO starlink_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity, conversation TO starlink_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA identity, conversation
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO starlink_app;

-- The whole point of this migration.
REVOKE ALL ON audit.ledger FROM starlink_app;
GRANT INSERT, SELECT ON audit.ledger TO starlink_app;

-- Request context DOES expire, so the app may delete here — that is the split working:
-- identifying context ages out while the ledger stays intact (doc §31.4).
REVOKE ALL ON audit.request_context FROM starlink_app;
GRANT INSERT, SELECT, DELETE ON audit.request_context TO starlink_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT INSERT, SELECT ON TABLES TO starlink_app;

-- ------------------------------------------------------------ compliance read role
-- Reading the ledger is itself an audited act; whoever investigates is accountable too.
GRANT USAGE ON SCHEMA audit TO starlink_audit_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA audit TO starlink_audit_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT ON TABLES TO starlink_audit_reader;

-- ------------------------------------------------------------------ migrator role
GRANT ALL ON SCHEMA identity, conversation, audit TO starlink_migrator;
GRANT ALL ON ALL TABLES IN SCHEMA identity, conversation, audit TO starlink_migrator;

-- Belt and braces: a trigger that refuses ledger mutation regardless of role grants,
-- so a misconfigured deployment (app connected as owner/superuser) still cannot
-- rewrite history.
CREATE OR REPLACE FUNCTION audit.refuse_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.ledger is append-only (doc FR-AUD-1): % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER ledger_no_update
  BEFORE UPDATE ON audit.ledger
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_ledger_mutation();

CREATE TRIGGER ledger_no_delete
  BEFORE DELETE ON audit.ledger
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_ledger_mutation();
