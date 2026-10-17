-- Rollback for drizzle/0009_plan_board.sql (the plan board: vehicle_setup_day, plan_run,
-- plan_assignment).
--
-- REFERENCE ONLY — nothing in the repo runs this file, and no CI step reads it. It is the written
-- answer to "what do we type if 0009 has to come off", so that answer is not invented at 2 a.m.
--
-- READ FIRST
--  * The real rollback for a migration that has reached production is the **Neon restore point the
--    founder takes before the merge** (DATABASES.md). This file undoes 0009's *schema*; it cannot
--    bring back the rows it drops.
--  * Roll the deploy back first. Plan routes and the ramp iPad read and write all three tables on
--    every load (src/modules/plan/sql.ts), so dropping them under a running build makes both
--    screens answer "Couldn't load" until the previous build is back.
--  * Data loss, deliberately: the saved boards and every van setup ever confirmed at the ramp.
--    `vehicle_setup_day` is the only record of what a van actually had on board on a given day,
--    and the one tomorrow's default is read from, so copy it elsewhere first if that history
--    matters. Nothing else in the schema references these tables, so no other table loses a row.
--  * 0009 is additive — it altered no existing table — so there is nothing to put back. Dropping
--    the three tables returns the database to exactly its 0008 shape.
--  * `IF EXISTS` throughout, so a half-applied 0009 (the tables were created, the constraints were
--    not) rolls back with the same file, and a second run is a no-op rather than an error — the
--    same defensiveness 0009 itself is written with.
--
-- ORDER: `plan_assignment` first, because its foreign key is the one thing that would stop
-- `plan_run` from being dropped. The indexes and constraints go with their tables.

BEGIN;

DROP TABLE IF EXISTS "ops"."plan_assignment";
DROP TABLE IF EXISTS "ops"."plan_run";
DROP TABLE IF EXISTS "ops"."vehicle_setup_day";

COMMIT;

-- No type to drop: 0009 created none. The three word-valued columns are `text` with a CHECK, and
-- `plan_run.direction` reuses `leg_direction`, which 0000 created and 0001 handed to `migrator`.

-- Bookkeeping, afterwards and only if 0009 is meant to be applied *again*: drizzle tracks applied
-- migrations by file hash in `drizzle.__drizzle_migrations`, so while that row is there no build
-- will re-run this migration. Rolling back to fix forward (a new 0010) wants the row left alone.
-- To re-apply the same file, delete its row — identify it by ordering, not by a hash copied into
-- this comment, because the hash changes with the file:
--   SELECT id, hash, created_at FROM drizzle."__drizzle_migrations" ORDER BY created_at;
--   DELETE FROM drizzle."__drizzle_migrations" WHERE id = <the row whose created_at matches 0009>;
