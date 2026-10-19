-- Migration 0012 — why an agent run ended FAILED (ledger #77): codes and names only, so a
-- failure can be read back instead of vanishing into "FAILED steps=0".
ALTER TABLE "ops"."agent_run" ADD COLUMN "reason" text;