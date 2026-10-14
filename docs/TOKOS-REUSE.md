# Tokos reuse: copy / avoid

```
READER: Rudy. SOURCE: /workspace/tokos-tzfix @9aa5355 (2026-09-25); retro /workspace/tokos-retro/retrospective.md §7 items 12–16; reviews/CROSS-TEAM-PLAYBOOK.md.
```

## Copy (with changes)
| What | Where | Change for PPEC |
|---|---|---|
| Auth.js Credentials + JWT callbacks | src/auth.ts:1-110 | keep shape; re-read role/site from DB per request instead of trusting token claims |
| Next 16 proxy | src/proxy.ts:1-5 | redirect only; not authorization |
| DB driver switch neon-http vs postgres-js | src/db/index.ts:12-38 | add WebSocket Pool path for transactions |
| Manager re-check pattern | src/lib/tenancy.ts:62-71 (`requireStaffManager`) | generalize to `requireSiteRole(siteId, roles)` |
| Ownership helper | src/lib/ownership.ts:9-17 | add site_id to every lookup |
| Audit writer | src/lib/audit.ts:6-25 | write in the same transaction as the change; hash bodies |
| Timestamp helper + index naming | src/db/schema.ts:23-26 | add version/source_mode columns |
| drizzle.config.ts | drizzle.config.ts | two schemas (identity, ops) |
| Team process | CROSS-TEAM-PLAYBOOK.md (roles, gates 1–7, handoffs, DoD) | reuse as-is |

## Avoid
| Problem | Where | PPEC rule |
|---|---|---|
| Authorization by path prefix only | src/auth.ts:73-83 | per-handler RBAC + site scoping |
| Org-only scoping (IDOR) | src/lib/tenancy.ts:96-108 (`requireStaffClient`) | ID-swap matrix incl. same-tenant unassigned |
| Outbox without claim / SKIP LOCKED; silent "stub" fallback provider | src/lib/outbox.ts:54-106 | guarded claim; SIM provider explicit, never a silent fallback |
| Cron route fails open when CRON_SECRET unset | src/app/api/cron/outbox/route.ts:4-7 | fail closed |
| Hardcoded demo password, real-domain emails, password shown on login page | src/lib/demo-logins.ts:31, :37, :46, :73; src/app/login/page.tsx:66 | demo creds as env secrets; example.com emails |
| Demo mode inferred from missing keys, banner only | src/lib/env.ts:29-37 | explicit `DEMO_MODE` + `APP_DATA_CLASS` checked at boot |
| Regex PHI firewall as the only control | src/lib/phi.ts:1-16 | tokenization at ingest; regex only as a secondary scrubber |
| randomUUID ids | src/lib/ids.ts:1-3 | UUIDv7 |
| `db:push` script; no committed migrations | package.json scripts; no drizzle/ folder | generate + migrate only |
