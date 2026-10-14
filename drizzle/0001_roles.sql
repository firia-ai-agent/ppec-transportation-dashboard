-- B-02 database roles (ADR-009, database-lifecycle Part C). Group roles only: NOLOGIN, no passwords here.
-- Login users are created per environment outside the repo and granted one of these roles (recorded in DATABASES.md).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN CREATE ROLE migrator NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_gateway') THEN CREATE ROLE identity_gateway NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly') THEN CREATE ROLE readonly NOLOGIN NOBYPASSRLS; END IF;
END $$;
--> statement-breakpoint
-- The role running migrations must be able to hand objects to migrator (Neon: the project owner role).
GRANT migrator TO CURRENT_USER;
--> statement-breakpoint
-- migrator owns the schemas, tables, sequences and enum types (not the platform default owner; Tokos lesson).
DO $$ DECLARE r record; BEGIN
  ALTER SCHEMA ops OWNER TO migrator;
  ALTER SCHEMA identity OWNER TO migrator;
  FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('ops', 'identity') LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO migrator', r.schemaname, r.tablename);
  END LOOP;
  FOR r IN SELECT n.nspname, t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE t.typtype = 'e' AND n.nspname = 'public' AND t.typname = ANY (ARRAY[
             'source_mode','staff_role','actor_kind','leg_state','attendance_state','capability_state','reservation_state',
             'outbound_state','ack_state','task_state','thread_state','profile_state','need_item_state','leg_direction','leg_mode',
             'dispatch_ownership','channel','severity','securement','mobility','job_state','agent_run_state','roi_cohort','auth_scope']) LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO migrator', r.nspname, r.typname);
  END LOOP;
END $$;
--> statement-breakpoint
-- app_rw: DML on ops only, never identity (ADR-011 boundary). No TRUNCATE, no CREATE.
GRANT USAGE ON SCHEMA ops TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ops TO app_rw;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO app_rw;
--> statement-breakpoint
-- Append-only logs: no UPDATE/DELETE (DATA-MODEL §6.2). Outbox and message history: no DELETE (state changes only).
REVOKE UPDATE, DELETE ON ops.telemetry_point, ops.event_log, ops.audit_event, ops.job_fire_log, ops.attendance_event FROM app_rw;
--> statement-breakpoint
REVOKE DELETE ON ops.outbound_message, ops.message FROM app_rw;
--> statement-breakpoint
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA identity TO identity_gateway;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA identity TO identity_gateway;
--> statement-breakpoint
REVOKE UPDATE ON identity.consent_event FROM identity_gateway;
--> statement-breakpoint
GRANT USAGE ON SCHEMA ops TO readonly;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA ops TO readonly;
--> statement-breakpoint
-- Default privileges for objects migrator creates in later migrations. New append-only tables still need an
-- explicit REVOKE in their own migration (checked by src/db/migrations.test.ts).
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA ops GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA ops GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA ops GRANT SELECT ON TABLES TO readonly;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA identity GRANT SELECT, INSERT, UPDATE ON TABLES TO identity_gateway;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA identity REVOKE ALL ON TABLES FROM PUBLIC;
