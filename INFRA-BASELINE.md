# Infra baseline (infra-config-drift-check) — owner: Rudy

Status as of 2026-10-14 ~11:45 ET (PR B-01). Names only, never values. Update in the same PR as any infra change; checked before every prod deploy, at each milestone, and weekly.

## Environments
| Env | Where | Deploys from | Status |
|---|---|---|---|
| production (demo-prod, synthetic only, DECISION-LEDGER #17) | Vercel project `ppec-transportation-dashboard`, team firia1, region iad1 | `main` via git integration only (prod-release-gate rule 1) | **NOT CREATED — BLOCKED**: git link needs a GitHub Login Connection on the Vercel account (OAuth in browser) |
| preview | same project, per PR | PR branches via git integration | blocked on the above |
| local | developer machine | — | `APP_DATA_CLASS=SYNTHETIC pnpm dev` |

## Schedules / jobs
None yet. `vercel.json` has no `crons`. The per-minute `/api/cron/sweep` arrives in B-03 (PR-5) and must fail closed without `CRON_SECRET`. Vercel Cron runs on production only; previews call the sweep from the harness (DECISION-LEDGER #16).

## Build-time DB step
`pnpm vercel-build` = `node scripts/vercel-db-step.mjs && next build`. Previews migrate their own Neon branch on every build. Production is off unless `MIGRATE_PROD_ON_BUILD=1` and the ref is `main`. The step never prints a URL. See DATABASES.md.

## Env var names per environment (names only)
| Name | Prod | Preview | Kind | Set by | Status |
|---|---|---|---|---|---|
| APP_DATA_CLASS (=SYNTHETIC) | ✓ | ✓ | plain | Rudy | not set (no project) |
| DEMO_MODE | ✓ | ✓ | plain | Rudy | not set |
| DATABASE_URL, DATABASE_URL_UNPOOLED | ✓ main branch | ✓ per-preview branch | integration | Neon integration | not set (Neon blocked) |
| AUTH_SECRET, CRON_SECRET, SIM_WEBHOOK_SECRET, HMAC_PEPPER, DATA_KEY | ✓ | ✓ (distinct values) | sensitive | Rudy (generated, never printed) | not set |
| DEMO_DIRECTOR_PASSWORD, DEMO_COORDINATOR_PASSWORD, DEMO_FRONT_DESK_PASSWORD | ✓ | ✓ (distinct) | sensitive | Rudy | not set |
| OPENROUTER_API_KEY | ✓ | ✓ | sensitive | founder via Firia only (DECISION-LEDGER #19) | not set |
| MIGRATE_PROD_ON_BUILD (unset ⇒ off; `1` enables prod migrations on builds from `main` only) | only when releasing | – | plain | Rudy, per prod-release-gate | not set (off) |
| NEXT_PUBLIC_MAP_TILE_URL | ✓ | ✓ | plain | Rudy | not set |

## Database
See `DATABASES.md`. Rule: prod and preview never share a database branch; `DATABASE_URL` must never target [production, preview] on one value.

## Feature/mode flags (what each gates, file:line)
| Flag | Gates | Where |
|---|---|---|
| APP_DATA_CLASS | build and server boot refuse anything but `SYNTHETIC` | `src/lib/env.ts:9-24`, `next.config.ts:5`, `src/instrumentation.ts:4-6` |
| DEMO_MODE | (nothing yet) demo panel + APIs per ADR-014, from B-15 | — |

## Platform/account settings
- GitHub: private repo, free plan, **no branch protection/rulesets** (HTTP 403, DECISION-LEDGER governance record). CI is advisory; Veri review is the gate.
- Vercel team firia1: Pro since 2026-10-01 (per Firia, DECISION-LEDGER #18; not readable via API). Other projects on the team: `tokos`, `temporary-*` ×3 (not ours, not touched).
- Spend: see DECISION-LEDGER #20; status tracked in the B-01 PR description.
- OpenRouter: $100 credit limit on the key, set by the founder (2026-10-14, relayed by Firia). The key lives only in Vercel env (Production/Preview, sensitive); it is not set anywhere until the Vercel project exists.

## Webhooks/integrations
None yet. Pending: Vercel GitHub integration, Neon (Vercel-managed, Free plan).

## Known side-effects
- **Vercel import auto-deploy (2026-10-14):** right after the project was created, Vercel deployed automatically: `dpl_AwLye7jkbLsf1cTMeR9JpinF4SrN`, target **production**, from branch `team/ppe-10-b-02-schema` @ `f957e4e`, 13.6 s after creation. **It failed at build.** The project is still `live: false`, and nothing from this deployment serves traffic. This was Vercel's import behaviour, not a release; prod releases still go only from `main` under prod-release-gate.
