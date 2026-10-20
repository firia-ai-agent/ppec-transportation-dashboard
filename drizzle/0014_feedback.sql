-- Migration 0014 — staff feedback from the DEMO bar (ledger #82): words about a screen, read by the director.
CREATE TABLE "ops"."feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"page_path" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."feedback" ADD CONSTRAINT "feedback_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_site_status_idx" ON "ops"."feedback" USING btree ("site_id","status","created_at");