-- Fix-forward on migration 0007 (B-08: the two schema observations F4 and F6 in
-- docs/agent/B08-SLICE1-DEFERRED.md). 0007 is frozen — it reached a shared branch, and
-- DATABASES.md's rule is that a frozen migration is never edited — so both corrections are a new
-- file rather than an edit, and both are written to be a no-op on a second run.
--
--  * **F4 — 0007 backfilled `idempotency_key` and left `status` behind.** `status` was added with
--    `DEFAULT 'PENDING'`, so every row that already existed got PENDING, including rows that had
--    *already finished*: `committed_at IS NOT NULL` is the record of a call that was committed out
--    of PENDING by `commitCall`. A finished row left at PENDING is not a cosmetic wrong value —
--    `pendingCall()` (src/modules/agent/run/store.ts) reads exactly that predicate to decide a run
--    has an interrupted step, and `committedCalls()` filters PENDING rows *out* of the resume
--    cursor. So a mislabelled row would be re-driven as if its effect might not have happened, and
--    would be missing from the facts the next model turn is given. The backfill reads the status
--    back off the row's own result, which is self-describing (loop.ts writes it):
--      - `result->>'error_code'` present  → the call FAILED (`exec/effects.ts` `failed()` always
--        sets a code; so do the loop's own NO_EXECUTOR and EXECUTOR_ERROR commits)
--      - otherwise                        → the call EXECUTED (a successful result may be NULL,
--        when the executor returned neither data nor prompt facts)
--    Rows carrying `blocked_rule` or `proposal_rule` are excluded rather than guessed at: those are
--    BLOCKED and PROPOSED commits, and calling either one EXECUTED would overwrite a policy
--    outcome with a false one. Such a row cannot actually need this backfill — only the slice that
--    added `status` writes those markers, so any row that has one also has its real status — and
--    the exclusion is there so that stays true rather than being assumed.
--  * **F6 — the type 0007 created is not owned by `migrator`.** 0001 hands `migrator` the schemas,
--    the tables and the enum types, but its enum loop runs over a *hard-coded* list of the 24 names
--    0000 created (drizzle/0001_roles.sql l.27-30). `agent_tool_call_status` was created three
--    migrations later and is therefore still owned by whichever role ran 0007 — on Neon the project
--    owner, not `migrator`. ADR-009's rule is that `migrator` owns every object in the schema
--    (B-02; the "Tokos lesson" named in 0001), and ownership is what decides who may later ALTER or
--    DROP the type, so this is the one asymmetry 0007 left behind. Every future migration that
--    creates a type has to carry its own `ALTER TYPE … OWNER TO migrator` for the same reason;
--    src/db/migrations.test.ts now fails if any `public` enum is owned by anyone else.
--
-- Neither statement touches a table definition, so the drizzle snapshot for 0008 is 0007's: there
-- is no schema drift for `drizzle-kit generate` to find (same shape as data-only 0005).
UPDATE "ops"."agent_tool_call" SET "status" =
  CASE WHEN "result"->>'error_code' IS NOT NULL THEN 'FAILED' ELSE 'EXECUTED' END::"public"."agent_tool_call_status"
WHERE "committed_at" IS NOT NULL
  AND "status" = 'PENDING'
  AND "result"->>'blocked_rule' IS NULL
  AND "result"->>'proposal_rule' IS NULL;--> statement-breakpoint
-- Same shape as 0001's loop, so a type that is somehow absent is skipped instead of failing the
-- migration, and re-running is a no-op (ALTER … OWNER TO the current owner changes nothing).
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE t.typtype = 'e' AND n.nspname = 'public'
             AND t.typname = ANY (ARRAY['agent_tool_call_status']) LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO migrator', r.nspname, r.typname);
  END LOOP;
END $$;
