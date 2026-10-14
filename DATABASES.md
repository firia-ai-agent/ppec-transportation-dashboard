# Databases (database-lifecycle) — owner: Rudy

| DB | Provider / plan | Branch | Used by | Roles | Backups / PITR | Last restore drill |
|---|---|---|---|---|---|---|
| ppec prod (demo-prod, synthetic) | Neon Free via Vercel-managed integration (planned) | `main` | Vercel production only | migrator, app_rw, identity_gateway, readonly (B-02) | Free-plan restore window: to record from Neon docs at setup | none yet (first before M2 sign-off) |
| ppec preview | same Neon project | `preview/<git-branch>` per deployment | Vercel preview only | same | n/a (ephemeral) | n/a |

Status 2026-10-14: **not created** (BLOCKED on Vercel project git link + marketplace consent). No orphan DBs known; none may be created outside this table.
Migrations: `drizzle-kit generate` → reviewed SQL in a PR → applied **inside the Vercel build** by `scripts/vercel-db-step.mjs` (`pnpm vercel-build`), so no connection string leaves Vercel. `push` only against disposable local DBs.

### Where migrations run (decided: build step, not a route)
| Vercel env | Migrates? | Against | Gate |
|---|---|---|---|
| preview | yes, every build | that preview's own Neon branch (`DATABASE_URL_UNPOOLED`) | a missing URL fails the build |
| production | **off by default** | Neon `main` | only when `MIGRATE_PROD_ON_BUILD=1` **and** `VERCEL_GIT_COMMIT_REF=main` (prod-release-gate); take a Neon snapshot first |
| local / CI | no | none (CI uses PGlite) | n/a |
Migrations use drizzle's node-postgres migrator and are tracked in `drizzle.__drizzle_migrations`, so re-running is a no-op. Logs print only RUN/SKIP, the reason, the count and the `ep-…` endpoint id; errors are scrubbed of URLs and credentials. The demo-user seed runs right after, on preview only (added in the Auth.js PR #6).

## Migrations in repo
| # | File | What | Rollback |
|---|---|---|---|
| 0000 | drizzle/0000_init.sql | enums, `ops` + `identity` schemas, 56 tables, 93 FKs (ON DELETE RESTRICT; none on append-only logs; none ops→identity; identity→ops.site and guardian_contact→family_group allowed), indexes, task evidence check, job `claimed_until` | fresh DB: drop schemas `ops`, `identity` and enums (no data yet); after data: restore from the Neon snapshot taken that hour |
| 0001 | drizzle/0001_roles.sql | NOLOGIN group roles migrator (owns schemas/tables/enums), app_rw (ops DML; no DELETE on outbound_message/message; no UPDATE/DELETE on append-only logs), identity_gateway, readonly; ALTER DEFAULT PRIVILEGES for later migrations. Note for B-15: demo reset needs TRUNCATE, so it runs as migrator, not app_rw | `REVOKE` grants; `DROP ROLE` (only if no login users are members) |
| 0002 | drizzle/0002_job_wake_published.sql | `ops.job.wake_published_at` (NULL ⇒ sweeper re-publishes the wake-up) | `ALTER TABLE ops.job DROP COLUMN wake_published_at` |
Applied so far: PGlite only (CI tests). Real Neon: not yet (U8 open).
