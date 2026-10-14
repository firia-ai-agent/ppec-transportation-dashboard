-- B-02 database roles (ADR-009, database-lifecycle Part C). Group roles only: NOLOGIN, no passwords here.
-- Login users are created per environment outside the repo and granted one of these roles (recorded in DATABASES.md).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN CREATE ROLE migrator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_gateway') THEN CREATE ROLE identity_gateway NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly') THEN CREATE ROLE readonly NOLOGIN NOBYPASSRLS; END IF;
END $$;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA ops, identity TO migrator;
--> statement-breakpoint
-- app_rw: DML on ops only, never identity (ADR-011 boundary).
GRANT USAGE ON SCHEMA ops TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ops TO app_rw;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO app_rw;
--> statement-breakpoint
-- Append-only logs: no UPDATE/DELETE (DATA-MODEL §6.2).
REVOKE UPDATE, DELETE ON ops.telemetry_point, ops.event_log, ops.audit_event, ops.job_fire_log, ops.attendance_event FROM app_rw;
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
