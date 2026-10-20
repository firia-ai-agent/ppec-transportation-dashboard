-- Migration 0016 — what the fast model made of a family's text (ledger #85; PRD RES-01, SURF-03).
ALTER TABLE "ops"."message" ADD COLUMN "triage_relevance" text;