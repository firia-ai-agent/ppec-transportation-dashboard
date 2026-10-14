# Infra baseline (infra-config-drift-check) — owner: Rudy

Status as of 2026-10-14 ~13:20 ET (updated in PR #9; first written in PR B-01). Names only, never values. Update in the same PR as any infra change; checked before every prod deploy, at each milestone, and weekly.

## Environments
| Env | Where | Deploys from | Status |
|---|---|---|---|
| production (demo-prod, synthetic only, DECISION-LEDGER #17) | Vercel project `ppec-transportation-dashboard`, team firia1, region iad1 | `main` via git integration only (prod-release-gate rule 1) | **created 2026-10-14**, git-linked, Production Branch Tracking = `main` (verified, see Known side-effects); live at https://ppec-transportation-dashboard.vercel.app |
| preview | same project, per PR | PR branches via git integration | live; each preview gets its own Neon branch |
| local | developer machine | — | `APP_DATA_CLASS=SYNTHETIC pnpm dev` |

## Schedules / jobs
| What | Where | Schedule | Auth | Since |
|---|---|---|---|---|
| Vercel Cron → `GET /api/cron/sweep` | `vercel.json` `crons` | `* * * * *` (ARCHITECTURE §6; needs Pro) | `Authorization: Bearer $CRON_SECRET`, fails closed (401) if unset, <16 chars or wrong (`src/lib/cron-auth.ts`) | B-03 PR (a) |
| Queue trigger `ppec-timer` → `POST /api/queues/timer` | `vercel.json` `functions.experimentalTriggers` (`queue/v2beta`, Vercel Queues Beta) | on message (delayed wake-ups) | not publicly invocable (Vercel Queues) | B-03 PR (a) |
| ~~GitHub Action `pr-preview-cleanup`~~ (superseded by #43, PR #13 closed) → Vercel API (list + `DELETE /v13/deployments/{id}`) | `.github/workflows/pr-preview-cleanup.yml` (PR #13) | on `pull_request` closed | repo secret `VERCEL_TOKEN` (firia1 team only); no-op if unset; never production | DECISION-LEDGER #42 |
| Queue trigger `ppec-outbox` → `POST /api/queues/outbox` | `vercel.json` `functions.experimentalTriggers` (`queue/v2beta`) | on enqueue commit (drain one message) | not publicly invocable; drain is idempotent | B-03 PR (b) |

Vercel Cron runs on **production only**. Previews have no cron: the harness calls `/api/cron/sweep` with the same header (DECISION-LEDGER, previews call the sweep route themselves). Any change to these rows needs an INFRA-TEMP entry if temporary.

## Build-time DB step
**Single DB (DECISION-LEDGER #43):** after PR #18, previews skip migrate and seed and run read-only against Neon `main`; only production from `main` with `MIGRATE_PROD_ON_BUILD=1` migrates. Neon preview branching in integration `icfg_Zyt0C77LtG5UqJhPMeARUPNd` was **turned off by Firia** in the dashboard on 2026-10-14 (~2:25 PM ET) after #18 merged (bdbba05); `DATABASE_URL`/`DATABASE_URL_UNPOOLED` now cover Preview with main's values. Deleting the old Neon preview branches is pending (founder email verification in Neon). The per-branch text below is historical.

`pnpm vercel-build` = `node scripts/vercel-db-step.mjs && tsx scripts/vercel-seed.ts && next build`. The demo-user seed runs on preview only and never resets passwords. Previews migrate their own Neon branch on every build. Production is off unless `MIGRATE_PROD_ON_BUILD=1` and the ref is `main`. The step never prints a URL. See DATABASES.md.

## Env var names per environment (names only)
| Name | Prod | Preview | Kind | Set by | Status |
|---|---|---|---|---|---|
| APP_DATA_CLASS (=SYNTHETIC) | ✓ | ✓ | plain | Rudy | set |
| DEMO_MODE | ✓ | ✓ | plain | Rudy | set |
| DATABASE_URL, DATABASE_URL_UNPOOLED | ✓ main branch | ✓ per-preview branch | integration (one entry each, not per-target values) | Neon integration | set (part of the 18 Neon-integration names below) |
| AUTH_SECRET, CRON_SECRET, SIM_WEBHOOK_SECRET, HMAC_PEPPER, DATA_KEY | ✓ | ✓ (distinct values) | sensitive | Rudy (generated, never printed) | set |
| DEMO_DIRECTOR_PASSWORD, DEMO_COORDINATOR_PASSWORD, DEMO_FRONT_DESK_PASSWORD | ✓ | ✓ (distinct) | sensitive | Rudy | set |
| OPENROUTER_API_KEY | ✓ | ✓ | sensitive | founder via Firia only (DECISION-LEDGER #20) | set (sensitive; never read, set or echoed by Rudy) |
| MIGRATE_PROD_ON_BUILD (unset ⇒ off; `1` enables prod migrations on builds from `main` only) | `1` (production target only) | – | plain | Rudy, per prod-release-gate | **set 2026-10-14 12:45 ET** |
| NEXT_PUBLIC_MAP_TILE_URL | ✓ | ✓ | plain | Rudy | **not set** (the only app var still missing; not needed until the map UI) |

**Neon-integration names (18, names only, managed by the Vercel Neon integration, never edited by hand):** `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL_NO_SSL`, `POSTGRES_PRISMA_URL`, `POSTGRES_USER`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`, `NEON_PROJECT_ID`, `NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL`. The app reads only `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. Source: Vercel project env listing (names only), 2026-10-14 ~13:15 ET.

## Database
See `DATABASES.md`. Rule: prod and preview never share a database branch. `DATABASE_URL`/`DATABASE_URL_UNPOOLED` are single Neon-integration entries; the integration injects a per-branch database into each preview, so production and previews resolve to different Neon endpoints. Evidence: `/api/health` `dbEndpoint` = `ep-divine-brook-b73452bw` on production vs `ep-spring-dust-b71ps7tl` (#4 preview), `ep-red-tooth-b72v9hvi` (#6 preview), `ep-royal-fire-b7skbn8q` (#8 preview). No config change.

## Feature/mode flags (what each gates, file:line)
| Flag | Gates | Where |
|---|---|---|
| APP_DATA_CLASS | build and server boot refuse anything but `SYNTHETIC` | `src/lib/env.ts:9-24`, `next.config.ts:5`, `src/instrumentation.ts:4-6` |
| DEMO_MODE | (nothing yet) demo panel + APIs per ADR-014, from B-15 | — |
| AUTH_SECRET (secret) | Auth.js JWT signing; `/login` and `/whoami` fail at request time without it (build does not need it) | `src/auth.ts` |
| DEMO_*_PASSWORD (secret) | only read by `pnpm seed:demo-users` (dry run unless `--apply`); refuses <16 chars or non-SYNTHETIC | `src/auth/seed.ts` |

## Platform/account settings
- GitHub: private repo, free plan, **no branch protection/rulesets** (HTTP 403, DECISION-LEDGER governance record). CI is advisory; Veri review is the gate.
- Vercel team firia1: Pro since 2026-10-01 (per Firia, DECISION-LEDGER #19; not readable via API). Other projects on the team: `tokos`, `temporary-*` ×3 (not ours, not touched).
- Spend: see DECISION-LEDGER #21; status tracked in the B-01 PR description.
- OpenRouter: $100 credit limit on the key, set by the founder (2026-10-14, relayed by Firia). The key lives only in Vercel env (Production/Preview, sensitive); it is now set (DECISION-LEDGER #20); Rudy never reads, sets or echoes it.

## Webhooks/integrations
Vercel GitHub integration (git-linked project); Neon via the Vercel-managed integration (Free plan, DECISION-LEDGER #19).

## Known side-effects
- **Vercel import auto-deploy (2026-10-14):** right after the project was created, Vercel deployed automatically: `dpl_AwLye7jkbLsf1cTMeR9JpinF4SrN`, target **production**, from branch `team/ppe-10-b-02-schema` @ `f957e4e`, 13.6 s after creation. **It failed at build.** The project is still `live: false`, and nothing from this deployment serves traffic. This was Vercel's import behaviour, not a release; prod releases still go only from `main` under prod-release-gate.
- **Production branch check (closed 2026-10-14):** Firia confirmed in the Vercel dashboard that Settings > Environments > Production > Branch Tracking = `main`. The production-branch incident above is closed. Only `main` produces production deployments.

## Decisions (infra)
- **MIGRATE_PROD_ON_BUILD**, Accepted by default (Rudy, delegated by Firia, within founder locks), 2026-10-14. Source: Firia's delegation, 2026-10-14 12:43 ET: "decide whether MIGRATE_PROD_ON_BUILD should be on or off and log it in INFRA-BASELINE".
  - The flag stayed off for the first main deploy (the #4 merge, b47a8c6, which had no migrations).
  - Once #5 was on main (7b03dda), the prod-release-gate check passed: main head = #5's merge; prod `/api/health` showed `dataClass: SYNTHETIC`; 0000/0001 frozen (DATABASES.md, "Migrations in repo" → Frozen).
  - The flag was then set to `1` on the **production target only** (plain, not sensitive) via the Vercel connector.
  - The next main deploy (the #6 merge, 0b8d4b6, `dpl_BqjBt2YZr9zUg4aG98H6dKiyA3Wd`) logged `migrate: RUN (production from main with MIGRATE_PROD_ON_BUILD=1)` and `migrate: OK, 2 migrations recorded, endpoint ep-divine-brook-b73452bw`.
  - **Prod seeding stays off**: `seed demo users: SKIP (not a preview build)`. It waits for the founder-approved reset/seed buttons (B-15, DECISION-LEDGER #17).
  - **When it returns to off** (Veri): it stays `1` while `main` holds synthetic data only; it is revisited, and set back to off by default, before any non-synthetic data or any destructive migration (drop/rename/data rewrite) reaches `main`.
- **Failed production build `qkwgkbo6v` (`dpl_FRLxumUDEU8mJB1uPLSx8BnmMAxq`, 2026-10-14 12:44:26 ET, ERROR) — explained, harmless:**
  - Verified from Vercel's deployment metadata: commit `e9486b6` on `main` = the merge of PR #1 (docs/linear-map; changes only `docs/DECISION-LEDGER.md` and `docs/LINEAR.md`).
  - Cause: at e9486b6 the tree on `main` was docs-only (`.github`, `.gitignore`, `README.md`, `docs/`): no `package.json`, no app. The Next.js build had nothing to build and failed. PRs #4 (scaffold) and #5 were merged seconds later.
  - Why it is harmless: a failed build never gets promoted, so it never served traffic or touched a database (the DB step is part of the same build, so it never ran). `itkvizp31` (#4 merge, `b47a8c6`) was READY 4 s later and became production. `/api/health` on production has reported the current `main` commit ever since.
  - Guard: none added. It can't happen again: `main` now always contains the app, and docs-only changes on top of it (e.g. #3, b1df48c) build READY. An ignored-build step that skips docs-only commits was considered and **not** adopted: production would then lag `main` and `/api/health` would stop matching the `main` head that Veri checks, and a skipped build still uses a Neon preview branch on new branches.
- **Neon Free branch cap (2026-10-14 13:16 ET):** preview `kcpyelyub` (`dpl_Hre1pN4wkputDEiUS7pM57JsnVLZ`, PR #11) ended in ERROR, `BUILD_FAILED: Resource provisioning failed`, after 1 s with an empty build log. Cause, **inferred (empty build log)**, not shown in Vercel's logs and not counted in Neon (no Neon access): the Neon Free plan allows **10 branches per project** (Neon docs: plans; a new branch fails at the cap). `main` plus 9 git branches with previews were already in use, and #11's new git branch needed an 11th. Fix applied: the same commit was pushed to the existing (merged) branch `team/ppe-12-b-03-outbox`, which reuses its Neon branch (PR #12). **Mechanism:** with the Vercel-managed integration, a Neon preview branch is deleted only when the last Vercel deployment of that git branch is deleted. Deleting the git branch does nothing. Cleanup: one-time deletion of merged branches' preview deployments (DECISION-LEDGER #41) and the `pr-preview-cleanup` Action on PR close (#42). Repo setting "Automatically delete head branches" is on (2026-10-14). Every push is followed by a check of the Vercel status; a red Vercel check blocks the hand-off to Veri.
