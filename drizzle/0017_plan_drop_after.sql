-- Migration 0017 — where a route put a child's stop in the van's run: a child token, or "first" (ledger #90).
ALTER TABLE "ops"."plan_assignment" ADD COLUMN "drop_after" text;