-- Rollback for drizzle/0007_agent_tool_call_status.sql (B-08 slice 2, the agent run loop).
-- REFERENCE ONLY — nothing in the repo runs this file, and no CI step reads it. It is the written
-- answer to "what do we type if 0007 has to come off", so that answer is not invented at 2 a.m.
--
-- READ FIRST
--  * The real rollback for a migration that has reached production is the **Neon restore point the
--    founder takes before the merge** (DATABASES.md). This file undoes 0007's *schema*; it cannot
--    bring back the rows it drops.
--  * Roll the deploy back first. `src/modules/agent/run/store.ts` reads and writes both columns
--    below on every tool call, so dropping them under a running build fail-shuts every agent run.
--  * Data loss, deliberately: `status` and `idempotency_key` are the loop's persist-before-execute
--    record. Without them a PENDING row cannot be told from a committed one, which is the whole of
--    §11.1 resume. Copy `ops.agent_tool_call` elsewhere first if the audit trail still matters.
--  * `IF EXISTS` throughout, so a half-applied 0007 (the columns were added, the indexes were not)
--    rolls back with the same file, and a second run is a no-op rather than an error — the same
--    defensiveness 0007 itself is written with.
--
-- ORDER (each statement depends on the one above it)
--  1. the indexes, while the columns they are built on still exist;
--  2. the columns;
--  3. the enum type, which cannot be dropped while a column still has that type.
--
-- `agent_run_resume_idx` is dropped on the assumption that the resume sweep is going away with the
-- loop. If 0007 is being rolled back only to re-apply it, keep the index: it is covering, so it
-- costs one unused index and saves a table scan per sweep.

BEGIN;

-- 1. Indexes 0007 created (both with IF NOT EXISTS, so both may legitimately be absent).
DROP INDEX IF EXISTS "ops"."agent_run_resume_idx";
DROP INDEX IF EXISTS "ops"."agent_tool_call_idem_uq";

-- 2. Columns 0007 added. Dropping `idempotency_key` would take its unique index with it; the
--    explicit DROP INDEX above is kept so a rollback that stops here leaves nothing behind.
ALTER TABLE "ops"."agent_tool_call" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "ops"."agent_tool_call" DROP COLUMN IF EXISTS "status";

-- 3. The enum, now that no column is of that type. It lives in `public`: 0007 created it there
--    (drizzle's default), not in `ops`.
DROP TYPE IF EXISTS "public"."agent_tool_call_status";

COMMIT;

-- Bookkeeping, afterwards and only if 0007 is meant to be applied *again*: drizzle tracks applied
-- migrations by file hash in `drizzle.__drizzle_migrations`, so while that row is there no build
-- will re-run this migration. Rolling back to fix forward (a new 0008) wants the row left alone.
-- To re-apply the same file, delete its row — identify it by ordering, not by a hash copied into
-- this comment, because the hash changes with the file:
--   SELECT id, hash, created_at FROM drizzle."__drizzle_migrations" ORDER BY created_at;
--   DELETE FROM drizzle."__drizzle_migrations" WHERE id = <the row whose created_at matches 0007>;
