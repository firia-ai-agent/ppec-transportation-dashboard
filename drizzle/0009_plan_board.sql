-- Migration 0009 — the plan board (redesign spec §1.6 / §6, approved by the founder and Firia on
-- 2026-10-17): three NEW tables and nothing else.
--
-- Additive by instruction. No existing table is altered or dropped: `ops.vehicle` keeps its
-- columns, and `ops.vehicle_layout` / `ops.layout_position` keep both their rows and their other
-- readers. §1.6 also sketched five `default_*` columns on `ops.vehicle`; they are deliberately
-- NOT here, because the same instruction says new tables only, so the per-van fallback setup
-- lives in configuration (src/config/vans.ts) and is written into `vehicle_setup_day` by the
-- demo seed.
--
-- What the three tables are for:
--  * `vehicle_setup_day` — one van's equipment counts for one day, and the state they are in
--    (`DEFAULT` copied forward, `PLANNED` set on the board, `CHECKED` confirmed at the ramp).
--    This is the table the founder's 2:38 PM ET direction asks for: vans are generic, each piece
--    of equipment is a number, and the number is set when the van arrives. Today's planning
--    default is today's row, else the most recent `CHECKED` row for that van, else configuration
--    (src/domain/plan/setup.ts, which is where that rule is written once).
--  * `plan_run` + `plan_assignment` — the saved board, which used to be a `Map` in one serverless
--    instance's memory (src/modules/demo/plan-store.ts, now deleted): lost on redeploy, different
--    per instance, and unreadable from a second browser. `plan_run.version` is the ops audit
--    version, so a second coordinator saving over the first is a 409 the screen can explain
--    rather than a silent overwrite.
--
-- Written to be safe to re-run (a retried deploy step, a hand-applied file): every CREATE is
-- `IF NOT EXISTS` and every constraint is added inside a DO block that swallows `duplicate_object`.
-- No enum type is created — 0001 hands `migrator` a hard-coded list of enum names, so a type made
-- after it needs its own `ALTER TYPE … OWNER TO migrator` (0008's F6) — so the three word-valued
-- columns are `text` with a CHECK, and `direction` reuses the existing `leg_direction` enum.
-- Every foreign key is ON DELETE RESTRICT, which src/db/migrations.test.ts asserts for all of
-- `ops`. The rollback is docs/db/rollback/0009.sql.

CREATE TABLE IF NOT EXISTS "ops"."plan_assignment" (
	"plan_run_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"child_token" uuid NOT NULL,
	"vehicle_id" uuid,
	"bucket" text NOT NULL,
	"stop_seq" smallint,
	"pinned" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL,
	CONSTRAINT "plan_assignment_plan_run_id_child_token_pk" PRIMARY KEY("plan_run_id","child_token"),
	CONSTRAINT "plan_assignment_bucket_known" CHECK (bucket IN ('VAN','UNASSIGNED','FAMILY_DRIVES','ABSENT')),
	CONSTRAINT "plan_assignment_van_has_vehicle" CHECK ((bucket = 'VAN') = (vehicle_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops"."plan_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"direction" "leg_direction" NOT NULL,
	"saved_by" uuid,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops"."vehicle_setup_day" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"seats" smallint NOT NULL,
	"wheelchair_spots" smallint NOT NULL,
	"car_seats" smallint NOT NULL,
	"oxygen_mounts" smallint NOT NULL,
	"has_lift" boolean NOT NULL,
	"state" text DEFAULT 'DEFAULT' NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL,
	CONSTRAINT "vehicle_setup_day_state_known" CHECK (state IN ('DEFAULT','PLANNED','CHECKED')),
	CONSTRAINT "vehicle_setup_day_counts_sane" CHECK (seats >= 0 AND wheelchair_spots >= 0 AND car_seats >= 0 AND oxygen_mounts >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ops"."plan_assignment" ADD CONSTRAINT "plan_assignment_plan_run_id_plan_run_id_fk" FOREIGN KEY ("plan_run_id") REFERENCES "ops"."plan_run"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ops"."plan_assignment" ADD CONSTRAINT "plan_assignment_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ops"."plan_assignment" ADD CONSTRAINT "plan_assignment_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ops"."plan_assignment" ADD CONSTRAINT "plan_assignment_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."vehicle"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ops"."plan_run" ADD CONSTRAINT "plan_run_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ops"."plan_run" ADD CONSTRAINT "plan_run_saved_by_app_user_id_fk" FOREIGN KEY ("saved_by") REFERENCES "ops"."app_user"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ops"."vehicle_setup_day" ADD CONSTRAINT "vehicle_setup_day_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ops"."vehicle_setup_day" ADD CONSTRAINT "vehicle_setup_day_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."vehicle"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ops"."vehicle_setup_day" ADD CONSTRAINT "vehicle_setup_day_set_by_app_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "ops"."app_user"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_assignment_van_idx" ON "ops"."plan_assignment" USING btree ("plan_run_id","vehicle_id","stop_seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_run_site_date_dir_uq" ON "ops"."plan_run" USING btree ("site_id","service_date","direction");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_setup_day_uq" ON "ops"."vehicle_setup_day" USING btree ("vehicle_id","service_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vehicle_setup_day_site_date_idx" ON "ops"."vehicle_setup_day" USING btree ("site_id","service_date");--> statement-breakpoint
-- Ownership and grants, which a CREATE in this file does not get on its own.
--
-- 0001 hands `migrator` every object in `ops` and sets DEFAULT PRIVILEGES "for objects migrator
-- creates in later migrations" — but a migration is run by the role that holds the migration
-- login (on Neon, the project owner), not by `migrator` itself, so a table created here is owned
-- by that role and inherits none of those defaults. ADR-009's rule is that `migrator` owns every
-- object in the schema (the "Tokos lesson" named in 0001), and ownership decides who may later
-- ALTER or DROP; src/db/migrations.test.ts fails if any ops/identity table is owned by anyone
-- else. The grants are 0001's own set for `ops`, written out for these three tables, because the
-- deployed app connects as a login granted `app_rw` and would otherwise be refused on all three.
-- Neither statement is append-only, so neither needs 0001's REVOKE UPDATE/DELETE treatment.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT unnest(ARRAY['vehicle_setup_day','plan_run','plan_assignment']) AS t LOOP
    EXECUTE format('ALTER TABLE ops.%I OWNER TO migrator', r.t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ops.%I TO app_rw', r.t);
    EXECUTE format('GRANT SELECT ON ops.%I TO readonly', r.t);
  END LOOP;
END $$;
