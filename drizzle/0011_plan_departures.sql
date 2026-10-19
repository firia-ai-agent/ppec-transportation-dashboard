-- Migration 0011 — today's departure per van on a leg, where a planner changed it (ledger #76).
-- Additive: an empty object means every van leaves at the schedule's default (config/schedule.ts).
ALTER TABLE "ops"."plan_run" ADD COLUMN "departures" jsonb DEFAULT '{}'::jsonb NOT NULL;