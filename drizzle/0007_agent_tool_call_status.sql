-- B-08 slice 2, the agent run loop (PRD §11.1 l.924: "Each run = job with idempotency
-- (trigger_type, trigger_id); tool calls persisted before execution; resumes from last committed
-- result"). `ops.agent_run` already carried the idempotency index; the two things the loop needs
-- and the table did not have are here.
--
--  * `status` — the lifecycle of a persisted call. The row is written PENDING *before* the call is
--    executed, and the only ways out of it are the three policy verdicts (ALLOW → EXECUTED,
--    BLOCK → BLOCKED, PROPOSAL → PROPOSED) and a failed execution. `policy_decision` could not
--    carry this: it records what policy said, which is decided before the call runs and must not
--    be overwritten by what happened afterwards — on resume it is the authority on whether the
--    call was ever allowed to execute at all.
--  * `idempotency_key` — the key every external effect of one call must be idempotent on. A crash
--    between the persist and the effect leaves a PENDING row whose effect may or may not have
--    happened; resume re-drives the call with this same key, so the sink (ops.outbound_message's
--    own `idempotency_key`, a state transition's version guard) is what makes the second attempt a
--    no-op instead of a double send. Derived in code as `agent:<run_id>:<seq>`
--    (src/modules/agent/run/store.ts `callIdempotencyKey`), which is also the backfill below.
--
-- Written defensively so a retried deploy step or a hand-applied migration is a no-op rather than
-- an error: the type creation swallows duplicate_object, the columns are IF NOT EXISTS, and
-- `idempotency_key` is added nullable, backfilled and only then made NOT NULL. Nothing wrote
-- ops.agent_tool_call before this slice (B-08 slice 1 persisted nothing), so the backfill is
-- expected to touch zero rows; it exists so that a database which somehow has rows gets keys that
-- match the derivation above instead of failing the ALTER.
DO $$ BEGIN
  CREATE TYPE "public"."agent_tool_call_status" AS ENUM('PENDING', 'EXECUTED', 'BLOCKED', 'PROPOSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "ops"."agent_tool_call" ADD COLUMN IF NOT EXISTS "status" "agent_tool_call_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."agent_tool_call" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
UPDATE "ops"."agent_tool_call" SET "idempotency_key" = 'agent:' || "run_id"::text || ':' || "seq"::text WHERE "idempotency_key" IS NULL;--> statement-breakpoint
ALTER TABLE "ops"."agent_tool_call" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
-- The resume sweep reads one site's unfinished runs: QUEUED (a timer fired and re-triggered the run)
-- and RUNNING (a run whose process died mid-step).
CREATE INDEX IF NOT EXISTS "agent_run_resume_idx" ON "ops"."agent_run" USING btree ("site_id","state");--> statement-breakpoint
-- One effect key per call, enforced by the database and not only by the derivation.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tool_call_idem_uq" ON "ops"."agent_tool_call" USING btree ("idempotency_key");
