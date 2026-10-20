-- Migration 0015 — approved availability (ledger #83, PRD TRP-02) and the end of the leg's agreed window.
CREATE TABLE "ops"."availability" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"child_token" uuid NOT NULL,
	"contact_token" uuid,
	"direction" "leg_direction" NOT NULL,
	"service_date" date NOT NULL,
	"start_min" smallint NOT NULL,
	"end_min" smallint NOT NULL,
	"change_request_id" uuid,
	"approval_id" uuid,
	"superseded_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL,
	CONSTRAINT "availability_range" CHECK (start_min >= 0 AND end_min <= 1440 AND start_min < end_min)
);
--> statement-breakpoint
ALTER TABLE "ops"."trip_leg" ADD COLUMN "window_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops"."availability" ADD CONSTRAINT "availability_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."availability" ADD CONSTRAINT "availability_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_day_idx" ON "ops"."availability" USING btree ("site_id","service_date","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "availability_live_uq" ON "ops"."availability" USING btree ("child_token","service_date","direction") WHERE superseded_by IS NULL;--> statement-breakpoint
-- Ownership and grants, as 0009 writes them out (src/db/migrations.test.ts; the app connects as app_rw).
ALTER TABLE ops.availability OWNER TO migrator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.availability TO app_rw;--> statement-breakpoint
GRANT SELECT ON ops.availability TO readonly;
