# Databases (database-lifecycle) — owner: Rudy

| DB | Provider / plan | Branch | Used by | Roles | Backups / PITR | Last restore drill |
|---|---|---|---|---|---|---|
| ppec prod (demo-prod, synthetic) | Neon Free via Vercel-managed integration (planned) | `main` | Vercel production only | migrator, app_rw, identity_gateway, readonly (B-02) | Free-plan restore window: to record from Neon docs at setup | none yet (first before M2 sign-off) |
| ppec preview | same Neon project | `preview/<git-branch>` per deployment | Vercel preview only | same | n/a (ephemeral) | n/a |

Status 2026-10-14: **not created** (BLOCKED on Vercel project git link + marketplace consent). No orphan DBs known; none may be created outside this table.
Migrations: `drizzle-kit generate` → reviewed SQL → `drizzle-kit migrate` with the unpooled URL. `push` only against disposable local DBs.
