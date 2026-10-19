-- Migration 0013 — a time agreed with a family, "HH:MM": the van drops the child no earlier (ledger #79).
ALTER TABLE "ops"."plan_assignment" ADD COLUMN "not_before" text;
