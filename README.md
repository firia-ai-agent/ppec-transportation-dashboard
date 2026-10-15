# PPEC transportation dashboard

Transport fulfillment, attendance, family communication and scheduling for a pediatric prescribed extended care (PPEC) center serving children with disabilities. "Fulfillment" = fulfilling each child's approved transport needs.

**Status (2026-10-14):** spec approved by founder; no application code yet. Synthetic data only — no real child, family or staff data may enter this repo or its environments.

## Founder locks (full list: [docs/DECISION-LEDGER.md](docs/DECISION-LEDGER.md))
- Vercel (team firia1) + Neon now; AWS later behind seams
- Live agent: a free OpenRouter model for testing (model ID comes from config only, never hardcoded), token-only gateway; moving to a HIPAA-compliant endpoint later. Demo data only until then
- Mocked SMS/Twilio, Teams, truck GPS/navigation, vehicle configs; demo reset/replay/fault controls
- Simulation centered on 2216 Jog Rd, Greenacres FL 33415 (public landmarks only)
- Auth.js with real RBAC and site scoping
- POC exit: AT-01–AT-18 + TEST-INF-01 all PASS (mock)
- $100/month spend alert
- Team: Athena (research), Rudy (build), Veri (verify), Vera (UI/copy)

## Environments & links

No secrets here. Values live only in Vercel env vars.

| What | Where |
|---|---|
| GitHub repo | https://github.com/firia-ai-agent/ppec-transportation-dashboard |
| Vercel project | https://vercel.com/firia1/ppec-transportation-dashboard |
| Prod URL | https://ppec-transportation-dashboard.vercel.app (TBC: confirm after first prod deploy) |
| Database | Neon store `ppec-transportation-dashboard` (iad1, Free plan, via the Vercel integration): exactly **one** database, the Neon `main` branch (`ep-divine-brook`). Previews share it read-only; no per-preview branches (DECISION-LEDGER row 43) |
| Linear | https://linear.app/tokos/project/ppec-transport-dashboard-poc-mock-c71244c967e7 |
| Notion | https://app.notion.com/p/3f9ac450cdc181cda2becad4340b6833 |

Previews are read-only against that one database: the app opens every preview transaction `READ ONLY` (PR #20, ledger row 55) and the preview login role `ppec_preview` is read-only server-side (ledger row 53): the role and its grants are applied in Neon and tested on the pooled and unpooled hosts (SELECT works, UPDATE is refused, `identity` is refused), and Firia has **switched** the Vercel **Preview** `DATABASE_URL`/`DATABASE_URL_UNPOOLED` to that role (2026-10-14). Preview only — Production keeps the owner role — and previews that already exist keep the old values until they are redeployed, so check `/api/health` `dbRole` on the deployment in front of you rather than assuming. Previews never run migrations and never seed; migrations and reset/seed act on production only.

## Docs
- [PRD v1.0](docs/PRD-v1.0.txt)
- [Architecture](docs/ARCHITECTURE.md)
- [Data model](docs/DATA-MODEL.md) · [schema draft](docs/schema-draft.ts)
- [ADRs](docs/adr/)
- [Mocks & demo](docs/MOCKS-AND-DEMO.md)
- [Build plan](docs/BUILD-PLAN.md)
- [Risks & questions](docs/RISKS-AND-QUESTIONS.md)
- [Tokos reuse](docs/TOKOS-REUSE.md)
- [Research evidence](docs/research/)

## Development (B-01 scaffold)
```
pnpm install
APP_DATA_CLASS=SYNTHETIC pnpm dev     # boot refuses any other data class (ADR-015)
pnpm typecheck && pnpm lint && pnpm test && pnpm seed:lint
pnpm e2e                              # browser check: see "Map" below
```
Health: `GET /api/health` returns the deployed commit, environment, data class and the Postgres role the deployment logs in as (`dbRole`, from `SELECT current_user` — the role name only, never a credential, URL or host; `null` when the query cannot be made). Infra state: `INFRA-BASELINE.md`, `DATABASES.md`, `INFRA-TEMP.md`.

## Map (M5, ADR-008)
MapLibre GL + **OpenFreeMap vector tiles**, `positron` base style restyled per [design direction §5.1](docs/design/DESIGN-DIRECTION.md). Attribution "© OpenFreeMap © OpenStreetMap contributors" is always on screen, bottom-right, and is never removed ([OpenFreeMap terms](https://openfreemap.org/tos/) — free, as-is, no SLA; [OSM ODbL](https://www.openstreetmap.org/copyright)).

| Env var | Kind | Default | What it does |
|---|---|---|---|
| `NEXT_PUBLIC_MAP_TILE_URL` | public, non-secret | `https://tiles.openfreemap.org/styles/positron` | The only map config knob: the MapLibre style URL for the basemap. Any MapLibre-compatible style works. Validated at boot in `src/lib/env.ts`, resolved in `src/components/map/style.ts`. |

The tile worker MapLibre decodes vector tiles in is copied out of `node_modules` into `public/` by `scripts/copy-maplibre-worker.mjs`, which `pnpm dev` and `pnpm build` run first. Without it the bundler's guess at the worker URL 404s and the pane draws an empty canvas.

Walk the pane at `/map-preview` — no database, synthetic fixtures only (`src/fixtures/map.ts`). It is **behind staff sign-in**, and the signed-in role decides what it draws: the role × data matrix is `src/domain/access/map-view.ts`, which also holds the test-only synthetic session the browser check uses (a role and nothing else; refused outright whenever `VERCEL_ENV` is set, so no deployment can be opened with it).
```
APP_DATA_CLASS=SYNTHETIC DEMO_MODE=1 pnpm dev   # then sign in and open http://localhost:3000/map-preview
```

### Browser check
`pnpm e2e` builds the app, starts it, loads `/map-preview` in Chromium and writes `artifacts/map-preview.png` (gitignored) for a design review. It needs no database and no credentials. Playwright specs live in `e2e/`, away from `src/`, so vitest never picks them up.
```
pnpm e2e
```
