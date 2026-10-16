# Vercel Queues delayed delivery + OpenRouter ZDR routing (Sonnet live, free model for tests)

Author: Athena (research lead). Research only, no app code. All sources checked **2026-10-14** (ET) unless noted.
Labels: **Verified** (primary source URL), **Contradicted**, **Unverified**. Every item is also tagged with a decision status: **Proposed** means it's a recommendation only, and nothing here changes a ledger row.

Locks respected (not reopened): POC on Vercel + Neon, AWS later (ledger row 3); exactly **one** Neon database (`main`), no per-preview branches; previews use main's `DATABASE_URL`, never migrate or seed, and open read-only DB sessions (row 43, which superseded row 19); live agent through OpenRouter on synthetic data only (row 4); model is Claude Sonnet (current) via OpenRouter with `zdr:true` (row 14); Auth.js (row 8).

**Decided by founder 2026-10-14 15:29 ET (group chat):** testing uses a **free OpenRouter model** instead of Sonnet. (This replaces the founder's 15:28 ET "test with haiku"; no Haiku config is proposed.) The live model stays Sonnet with `zdr:true` (row 14, unchanged). Test-model details: §2A. Timer contingency Upstash QStash is still **Proposed** and needs founder sign-off (row 22). This doc doesn't change it.

## One-screen summary

1. **Vercel Queues is public beta, not GA.** It's available on all plans (Hobby includes the first 1M operations), and push consumers run on Fluid compute. Delays are **integer seconds**, from 0 up to 7 days, capped at the message TTL (60 s to 7 days, default 24 h).
2. **No published accuracy or SLA for when a delayed message is actually delivered.** Vercel says nothing on how closely delays are honored. Delivery is at-least-once, there's no FIFO, and failed messages retry (default 60 s, forced backoff after 32 attempts). PRD NFR-03 ("fire ≤5 s late, exactly once") **can't be claimed from docs**. It has to be measured: see the PROPOSED experiment in §1.6, which feeds the existing TEST-INF-01 / row 22 gate.
3. **"Exactly once" must come from our DB, not the queue.** Keep the `claimed_until` lease plus idempotent handlers (row 25). The Queues visibility timeout (API default 60 s; SDK default 300 s with auto-extend) is a separate lease and doesn't replace the job lease.
4. **OpenRouter can restrict Sonnet to ZDR endpoints.** `provider.zdr: true` (per request) ORs with account and guardrail ZDR. For current Sonnet (`anthropic/claude-sonnet-5.5`), the ZDR endpoints are **Amazon Bedrock and Google Vertex only**. The Anthropic first-party, Azure and "Claude Platform on AWS" endpoints aren't on the ZDR list, so `zdr:true` excludes them. Anthropic's own API retains inputs and outputs for up to 30 days.
5. **Test model (founder, 15:29 ET): `google/gemma-4-31b-it:free`**, tool calling verified; backups `nvidia/nemotron-3-super-120b-a12b:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`. **Most free endpoints don't offer ZDR, and some providers log prompts or use them for training.** None of the three has a ZDR endpoint. That's acceptable for testing only because all data is synthetic (row 4). Account-level ZDR is scoped per model group: the **Anthropic** toggle doesn't touch Gemma, but the **Google** toggle would block it (§2A.4).
6. **OpenRouter has no BAA** (its own statement). ZDR isn't HIPAA. Synthetic data only stays mandatory (row 4). PROPOSED config is in §2.5: `zdr:true`, `data_collection:"deny"`, `only:["amazon-bedrock","google-vertex"]`, `allow_fallbacks:false`, a pinned model slug and no `models` fallback list.

**What changes Rudy's build now:** (a) don't rely on Queues for exactly-once or for the ≤5 s bar until TEST-INF-01 measures it; (b) the model comes from `OPENROUTER_MODEL`; Sonnet always sends the §2.5 ZDR `provider` block, the one free test model is the only exception, and production refuses to start unless it's Sonnet + ZDR (§2.5); (c) `deliveryCount > 1` must be treated as normal (idempotency).

---

## 1. Vercel Queues delayed delivery

| # | Claim | Status | Source (checked 2026-10-14) |
|---|---|---|---|
| 1.1 | Queues is **Beta** ("Vercel Queues (Beta) are available on all plans"); public beta for all teams; the trigger type is `queue/v2beta`, configured via `experimentalTriggers` | Verified | https://vercel.com/docs/queues ; https://vercel.com/changelog/vercel-queues-now-in-public-beta |
| 1.2 | Delay is set per message: SDK `delaySeconds` / HTTP `Vqs-Delay-Seconds`, typed **integer**, 0 to 604,800 s (7 days), capped at TTL. If the delay exceeds the TTL, the message expires and is never delivered | Verified | https://vercel.com/docs/queues/api ; https://vercel.com/docs/queues/sdk ; https://vercel.com/docs/queues/concepts#delayed-delivery |
| 1.3 | Precision: the API exposes **1 s granularity** (integer seconds). Granularity isn't accuracy | Verified (granularity) / Unverified (accuracy) | https://vercel.com/docs/queues/api |
| 1.4 | Retention (TTL) is 60 s to 7 days, default 24 h. Visibility timeout is 0 to 3,600 s; HTTP API default 60 s with no auto-extend; JS SDK default 300 s and auto re-extends while the handler runs; `ExtendLease` exists | Verified | https://vercel.com/docs/queues/pricing#limits ; https://vercel.com/docs/queues/sdk ; https://vercel.com/docs/queues/concepts#visibility-timeout |
| 1.5 | Delivery is **at-least-once**. Duplicates are possible on visibility-timeout expiry and AZ failover. **No FIFO** ("approximate write order"). Retries continue until ack, TTL expiry, or trigger `maxDeliveries` (default unlimited); `retryAfterSeconds` defaults to 60 s; first 32 attempts use the configured delay, then forced backoff. No built-in DLQ. Messages stay pinned to the deployment that published them | Verified | https://vercel.com/docs/queues/concepts ; https://vercel.com/docs/queues/pricing#limits |
| 1.6 | Idempotency key dedup window is `min(retention, 24 h)`; dedup happens out-of-band after send returns | Verified | https://vercel.com/docs/queues/concepts |
| 1.7 | Plan: all plans. Hobby includes the first 1,000,000 Queue API operations; Pro is usage-based (regional pricing). Push deliveries are billed as function compute; a timed-out delivery bills full `maxDuration` | Verified | https://vercel.com/docs/queues/pricing |
| 1.8 | Fluid compute: push mode invokes consumers "with fluid compute" and is billed at Fluid rates. **Poll mode** works from any environment, so Fluid isn't strictly required for consumption. Whether push mode works on a project with Fluid disabled isn't stated | Verified (push uses Fluid) / Unverified (push with Fluid off) | https://vercel.com/docs/queues/concepts#push-mode ; https://vercel.com/changelog/vercel-queues-now-in-public-beta |
| 1.9 | **A published statement on how accurately delays are honored (latency from delay expiry to delivery, p50/p99, SLA)**: none found in the Queues overview, concepts, API, SDK, pricing and limits pages, or the beta changelog. Beta means no SLA | Unverified (no published statement) | same pages as above |

### 1.6 PROPOSED experiment for Rudy (TEST-INF-01 input; research labels only, no ledger change)
**Status: Proposed.** This is a docs/test harness and doesn't change product behavior.
- **Where it runs (Veri #21 blocker, row 43):** there is exactly ONE Neon database, shared by prod and previews; previews are read-only. So the experiment runs **(a) locally**, against a local Postgres (Docker) or no DB at all, with results written to a local JSONL/CSV file and a local `vercel dev` or poll-mode consumer; or **(b) on the synthetic production deployment only** (row 18 already allows TEST-INF-01 there). **Never on a preview.** On production, results go to the Vercel function logs (structured JSON lines exported after the run), **not** a scratch table. Creating any scratch table in the shared DB needs explicit Firia/founder approval first, and must then be dropped after the run.
- Publish N=300 messages with `delaySeconds` ∈ {3, 60, 900, 3600} (75 each), payload `{sentAtMs, delaySeconds, id}`, plus an idempotency key.
- The consumer logs `receivedAtMs - (sentAtMs + delay*1000)` (lateness), `deliveryCount`, and duplicates by `id` (synthetic only), to the local file or prod log lines above.
- Also run 20 messages where the handler throws once, to measure retry-to-redelivery time with `retryAfterSeconds` set to 1 s.
- Report p50, p95, p99 and max lateness, early deliveries (lateness < 0), duplicate rate, and any losses. **Pass bar = NFR-03: p100 ≤ 5 s late** across 3 runs (matching TEST-INF-01's 3 recorded runs). If it fails, row 22 (QStash, Proposed) goes to the founder; this doc doesn't decide that.

### 1.7 What this means for the PRD's timed jobs
- **NFR-03 (PRD l.513–514, "fire ≤5 s late, exactly once")**: neither half is guaranteed by Vercel docs. Exactly-once must come from the DB lease (`claimed_until`, row 25) plus idempotent effects (outbound state machine, row 28). ≤5 s is a measurement, not a documented property (1.9).
- **3 s vs 60 s lease**: this is our **DB job lease**, a separate decision from the Queues visibility timeout. (Veri's #17 review notes main is still on 60 s and the 3 s change lives in unmerged #10; that's ledger business, not reopened here.) Facts relevant to it: a 60 s DB lease means a crashed claim is retried by the sweeper up to ~60 s late, which breaks the 5 s bar for that job on its own; a 3 s lease needs handlers that finish or renew inside 3 s. The Queues default `retryAfterSeconds` (60 s) and API visibility timeout (60 s) would likewise put a failed delivery ~60 s late unless lowered. Whichever lease is chosen, set `retryAfterSeconds` and the visibility timeout to match it. **Proposed.**
- **Reminders (PRD l.284: T−90 request, T−60 reminder, T−45 escalation, T−30/−15/−5 readiness)**: these are all well under the 7-day max delay, so a single delayed message fits. Because there's no FIFO and redelivery is possible, each handler must re-check current state (cancelled, already sent, plan version) at fire time before sending. Anything scheduled more than 7 days out needs the cron sweep or daisy-chaining (concepts page). **Proposed.**
- **Deployment pinning**: messages stay with the publishing deployment, so a preview's delayed jobs fire in the preview (which, under row 43, has read-only DB access and must not consume writing jobs), and an old prod deployment keeps consuming its in-flight messages after a promote. Set `maxDeliveries` so a stale deployment stops retrying. This matters for the preview-isolation work (#18 and #20). **Proposed.**

---

## 2. OpenRouter routing for Claude Sonnet

| # | Claim | Status | Source (checked 2026-10-14) |
|---|---|---|---|
| 2.1 | Per-request `provider.zdr: true` routes only to ZDR endpoints. It ORs with account-level and guardrail ZDR, so it can turn ZDR on but never off | Verified | https://openrouter.ai/docs/features/zdr ; https://openrouter.ai/docs/features/provider-routing |
| 2.2 | `provider.data_collection: "deny"` means use only providers that don't collect user data (non-transient storage or training). That's weaker than ZDR: OpenRouter notes some providers don't train but do retain | Verified | https://openrouter.ai/docs/features/provider-routing ; https://openrouter.ai/docs/features/zdr |
| 2.3 | `provider.only` is an allow-list (an account allow-list acts as a ceiling). `order` sets try order. `allow_fallbacks:false` stops fallback beyond listed providers. Base slugs (`google-vertex`) match all regions | Verified | https://openrouter.ai/docs/features/provider-routing |
| 2.4 | Account-level ZDR is a per-model-group toggle in privacy settings. The **Anthropic** group toggle "Removes first-party Anthropic endpoints (Bedrock and Vertex remain available)". Guardrail field `enforce_zdr_anthropic`; legacy `enforce_zdr` is deprecated | Verified | https://openrouter.ai/docs/features/zdr |
| 2.5 | Current Sonnet on OpenRouter is `anthropic/claude-sonnet-5.5` (newest Sonnet in `/api/v1/models`). Endpoints: Google Vertex (global/us/europe), Amazon Bedrock, Azure (global/us), Claude Platform on AWS, Anthropic | Verified | https://openrouter.ai/api/v1/models ; https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints |
| 2.6 | ZDR-flagged Sonnet 5.5 endpoints: **`google-vertex/global`, `google-vertex/us`, `google-vertex/europe`, `amazon-bedrock`**. Anthropic first-party, Azure and Claude-on-AWS aren't on the ZDR list. (Sonnet 5 and 4.6 are similar: Bedrock and Vertex only) | Verified | https://openrouter.ai/api/v1/endpoints/zdr ; https://openrouter.ai/docs/features/zdr |
| 2.7 | Anthropic first-party retention: the Anthropic API deletes inputs and outputs within 30 days, with exceptions (e.g. Files API, policy flags) | Verified | https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data |
| 2.8 | Bedrock and Vertex retention: OpenRouter classifies these Sonnet endpoints as ZDR, but that's OpenRouter's classification. It treats in-memory implicit caching as not retention (these endpoints show "Implicit caching: No"). I didn't check the AWS or Google primary terms for what they retain (e.g. abuse-monitoring logs) | Verified (OpenRouter classification) / Unverified (AWS and Google primary terms) | https://openrouter.ai/docs/features/zdr |
| 2.9 | OpenRouter itself doesn't retain prompts unless you opt in to prompt logging | Verified | https://openrouter.ai/docs/features/zdr |
| 2.10 | ZDR doesn't cover plugins or server tools (web search etc.) | Verified | https://openrouter.ai/docs/features/zdr |
| 2.11 | **When no ZDR endpoint is available**: docs say an `only` list with no match "fails with a 404". For a `zdr` filter with zero eligible endpoints, the docs don't state the error. A 404 "no endpoints" is expected but unconfirmed. With a `models` fallback list, routing could move to another **model**, so don't send one | Verified (404 for `only` mismatch) / Unverified (exact zdr-empty behavior) | https://openrouter.ai/docs/features/provider-routing |
| 2.12 | **OpenRouter offers no HIPAA BAA**, by its own statement | Verified | https://openrouter.ai/blog/insights/governing-team-ai-spend/ (as cited in EV-VERIFICATION.md) |

### 2A. Free test model (Decided by founder 2026-10-14 15:29 ET)

| # | Claim | Status | Source (checked 2026-10-14) |
|---|---|---|---|
| 2A.1 | Chosen: **`google/gemma-4-31b-it:free`** (Google DeepMind Gemma 4 31B Instruct, released 2026-04-02, Apache 2.0, 262K context). `supported_parameters` includes `tools` (and its one endpoint lists `tools`). Picked as a non-preview, stable open-weights release with native function calling | Verified | https://openrouter.ai/api/v1/models ; https://openrouter.ai/api/v1/models/google/gemma-4-31b-it:free/endpoints ; https://openrouter.ai/google/gemma-4-31b-it:free |
| 2A.2 | It has **one** endpoint: **Google AI Studio** (`google-ai-studio`). It's **not** in OpenRouter's ZDR endpoint list | Verified | https://openrouter.ai/api/v1/models/google/gemma-4-31b-it:free/endpoints ; https://openrouter.ai/api/v1/endpoints/zdr |
| 2A.3 | Backups (both list `tools`; one Nvidia endpoint each; neither is ZDR): `nvidia/nemotron-3-super-120b-a12b:free` (status 0) and `nvidia/nemotron-3-ultra-550b-a55b:free` (endpoint status −2 today, i.e. degraded; second backup only) | Verified | https://openrouter.ai/api/v1/models/nvidia/nemotron-3-super-120b-a12b:free/endpoints ; https://openrouter.ai/api/v1/models/nvidia/nemotron-3-ultra-550b-a55b:free/endpoints ; https://openrouter.ai/api/v1/endpoints/zdr |
| 2A.4 | **Account-level ZDR is scoped per model group, not account-wide only.** Five toggles: Anthropic (removes first-party Anthropic; Bedrock/Vertex remain), OpenAI, Google (removes AI Studio; Vertex remains), SpaceXAI, All other models. Same scopes exist on guardrails, which apply per API key / member. So the **Anthropic** toggle Firia plans does **not** block Gemma; the **Google** toggle **would** (Gemma free is AI Studio only), and **All other models** would block the Nvidia backups | Verified | https://openrouter.ai/docs/features/zdr |
| 2A.5 | **Most free endpoints don't offer ZDR, and some providers log prompts or use them for training.** OpenRouter has a separate account setting for allowing providers that may train on data, **for free models**, and assumes retain+train where a policy is unclear. Synthetic data only makes this acceptable for tests | Verified | https://openrouter.ai/docs/features/zdr ; https://openrouter.ai/docs/guides/privacy/provider-logging |
| 2A.6 | Google AI Studio's exact retention/training terms for the free Gemma endpoint (and Nvidia's for the backups) | Unverified (the per-provider table didn't render in the docs fetch) | https://openrouter.ai/docs/guides/privacy/provider-logging#data-retention--logging |
| 2A.7 | Haiku (`anthropic/claude-haiku-5.5`, ZDR on Bedrock/Vertex) was checked at 15:28 and dropped by the founder at 15:29; kept here only as a fallback note if a ZDR-capable cheap test model is ever needed | Verified | https://openrouter.ai/api/v1/endpoints/zdr |

### 2.5 PROPOSED request config for Rudy
**Status: Proposed, and partly Superseded by §2.5A below.** It implements locked rows 4 and 14 (`zdr:true` for the live Sonnet model) without changing them, plus the founder's 15:29 ET test-model decision.

> **Superseded 2026-10-15 (founder).** The **Live (Sonnet)** block and the **production start-up guard** in this section are kept as reference for the later switch to a HIPAA-compliant endpoint and are **not built** in B-08 slice 5. What slice 5 built instead is §2.5A: model ids from config only, and the fail-shut demo-data guard. The **Test** block below is what ships — `allow_fallbacks:false` and `require_parameters:true` on every request, no `zdr`/`only` pinning for the free endpoints. The outbound-body test survives in the shape §2.5A describes: it matches the config allow-list rather than a slug written into the test.

Model ID comes from env: `OPENROUTER_MODEL` (Vercel env per row 20). Exactly two values are allowed.

**Live (production; and any environment using Sonnet):**
```json
{
  "model": "anthropic/claude-sonnet-5.5",
  "messages": [ ... ],
  "provider": {
    "zdr": true,
    "data_collection": "deny",
    "only": ["amazon-bedrock", "google-vertex"],
    "order": ["amazon-bedrock", "google-vertex"],
    "allow_fallbacks": false,
    "require_parameters": true
  }
}
```

**Test (previews and local only):**
```json
{
  "model": "google/gemma-4-31b-it:free",
  "messages": [ ... ],
  "provider": {
    "allow_fallbacks": false,
    "require_parameters": true
  }
}
```
- No `zdr`/`only` pinning for the test model (it has no ZDR endpoint, so `zdr:true` would just 404). Never send `models: [...]` in either mode. Pin exact slugs, not `~...-latest`.
- **Production start-up guard:** when `VERCEL_ENV === "production"`, the app refuses to start (throws at config load / boot) unless `OPENROUTER_MODEL === "anthropic/claude-sonnet-5.5"` and the built provider block has `zdr:true`, `allow_fallbacks:false`, and `only` ⊆ `["amazon-bedrock","google-vertex"]`. The free model is allowed only when `VERCEL_ENV` is `preview` or `development`/local. A unit test covers: prod + Sonnet + ZDR boots; prod + free model fails; prod + Sonnet without ZDR fails.
- **Outbound-body test:** for every request, if model is Sonnet then `provider.zdr === true` and `allow_fallbacks === false`; the single exception allowed without `zdr` is exactly `google/gemma-4-31b-it:free` (with `allow_fallbacks === false`); **any other model without `zdr:true` fails the test.** Switching to a backup is a deliberate PR that updates the allow-list.
- Account side (Firia): turn on ZDR for the **Anthropic** group only and keep prompt logging off. **Don't** turn on the Google group (it blocks Gemma free) or All other models (blocks the Nvidia backups) unless tests move off them. The free-model "may train" setting must be allowed for the test model to route. If a single account setting can't satisfy both, **Proposed:** rely on per-request `provider.zdr:true` for Sonnet (it ORs with account settings), and use two API keys with separate guardrails: a prod key whose guardrail enforces ZDR for all groups, and a preview/local key without it.
- On 404 or no endpoints, treat it as a hard failure and show the agent as unavailable or hand off to staff. **Never retry without `zdr`** for Sonnet.

**Decided by founder 2026-10-15 07:21 ET (group chat):** the live agent uses a free OpenRouter model for now, on demo data only, and moves to a HIPAA-compliant endpoint later. The model ID lives in config. This replaces the "live model stays Sonnet + ZDR" requirement. The §2.5 Sonnet "Live" block and its production start-up guard are now **Superseded** (kept as reference for the later switch). Model pick, OK'd by Firia 2026-10-15: `google/gemma-4-31b-it:free`, with `nvidia/nemotron-3-super-120b-a12b:free` as backup.

### 2.5A Demo-data-only guard (replaces the Sonnet + ZDR production guard)
**Status: Proposed.** No ledger row changes.

- **Model from config only.** `OPENROUTER_MODEL` comes from config/env and must be on a config allow-list (Gemma free, Nemotron backup). Test: fails if any model slug is hard-coded anywhere in `src/` outside that config.
- **Fail-shut demo mode.** The agent refuses to start or make any model call unless an explicit demo-only flag is set (e.g. `AGENT_DATA_MODE=demo`). Tests: set boots; missing refuses; empty or any other value refuses.
- **Why the guard matters.** None of the free endpoints offer ZDR, and some log or train on prompts (§2A.2, §2A.6). OpenRouter has no BAA. So the guard is the only thing keeping real family data out.
- **Later switch.** Moving to the compliant endpoint means changing config and removing demo mode, and it's gated on a signed BAA. Which endpoint to use is still undecided (Unverified/open).
- Every request keeps `allow_fallbacks:false` and `require_parameters:true`. Keep the keyword fallback for rate limits, and keep the outbound-body test's allow-list matching the config allow-list.
- Account side: leave OpenRouter's **Google** ZDR toggle off while testing on Gemma, because it blocks Gemma free (§2A.4).

### 2.5B As built in B-08 slice 5 (Status: Built)
§2.5A above is the founder's note, verbatim. This subsection records what the code actually does, because two of the names in it had to change and anyone following the note needs to know which to use.

**Env var names — two deliberate deviations from §2.5A.**

| §2.5A says | Code uses | Why |
|---|---|---|
| `OPENROUTER_MODEL` | `AGENT_MODEL`, plus `AGENT_BACKUP_MODEL` and `AGENT_MODEL_ALLOW_LIST` | `src/modules/agent/config.ts` already owned the `AGENT_*` prefix for every knob in the seam; a second prefix for one field would have put the model somewhere a deployment review wouldn't look. The backup needed a name of its own once the fallback chain became primary → backup → keyword. |
| `AGENT_DATA_MODE=demo` | `AGENT_DEMO_DATA_ONLY=true` | **`AGENT_DATA_MODE` already exists** on that module with different semantics — `SYNTHETIC` \| `PHI`, the switch that makes `vendorAttestation` mandatory in the gateway (PRD §11.2). Adding a third value `demo` would have made one var answer two unrelated questions: what the gateway must demand of the vendor, and whether the operator has confirmed this deployment holds only demo data. They are now two vars with two jobs, and a test pins that each keeps its own meaning. |

- **Required value is exact.** `AGENT_DEMO_DATA_ONLY` must be exactly `true`. Missing, empty, `" true "`, `TRUE`, `True`, `1`, `yes`, `false`, `0` and `demo` all leave the guard shut, because every looser rule (truthiness, case-insensitive compare, "any non-empty value") turns a stray character or a leftover `=0` into permission to call a vendor that may log prompts.
- **Fail shut, and before anything else.** `providers/remote.ts` refuses with `RemoteProviderNotEnabled` *before* it reads the key, builds a body or constructs a URL — a deployment with a working key and no demo confirmation is the dangerous one, so the refusal names only the demo setting. Re-checked on every `invoke()`, not just at wiring time. Tests assert `fetch` was never called on each refusal path.
- **Model ids.** `MODEL_PRIMARY` = `google/gemma-4-31b-it:free`, `MODEL_BACKUP` = `nvidia/nemotron-3-super-120b-a12b:free`, both in `config.ts` and nowhere else; `modelAllowList` refuses anything else at config time. `no-hardcoded-models.test.ts` scans every `.ts`/`.tsx` under `src/` — production and tests alike — and fails on a model name or id, with three exclusions: `config.ts`, its test, and the scanner itself.
- **Fallback chain.** Primary → backup on a 429 *or any other failure* → the PRD §18.1 keyword parser (`providers/keyword.ts`). A free endpoint has more ways to fail than a rate limit, so a 500, a 401, a network error, a malformed envelope, a non-JSON body and the adapter's own timeout (`AGENT_REQUEST_TIMEOUT_MS`, default 20 s) all behave the same way. The keyword parser emits only `escalate_exception` — it classifies ABSENT/SICK/YES/READY/STOP into a staff triage item and never guesses a cancellation or an acknowledgment.
- **ZDR block.** Sent only when `AGENT_MODEL_ZDR` is on, so the demo deployment sets `AGENT_MODEL_ZDR=0`: the free endpoints have no ZDR to offer and OpenRouter's Google toggle blocks Gemma free outright (§2A.4). `allow_fallbacks:false` and `require_parameters:true` are on **every** request regardless.
- **Outbound-body test**, in the §2.5A shape: it asserts each request's `model` is one `modelAllowList` admits, rather than comparing against a slug written into the test. Switching models is still a deliberate PR — it moves `AGENT_MODEL` and `AGENT_MODEL_ALLOW_LIST` together, and the config refuses to parse if they disagree.
- **Not built, by instruction (§2.5, Superseded).** The Sonnet + ZDR production start-up guard — the `VERCEL_ENV === "production"` refusal — is documented only. It belongs to the later HIPAA-compliant endpoint, which is gated on a signed BAA and whose endpoint choice is still open (Unverified #2/#5 below). Nothing in slice 5 reads `VERCEL_ENV`.
- **Still open after slice 5.** No token or cost accounting (`ops.agent_run.tokens_in/out` stay NULL), and no retry on a transient failure beyond the one backup attempt — a 429 degrades to keyword rather than backing off and retrying. Both are named on `docs/agent/B08-SLICE1-DEFERRED.md`.

---

## Ranked Unverified list (owner / how to verify)

1. **Delay accuracy (≤5 s, NFR-03)**. Owner: Rudy (run), Veri (review). Verify: run the §1.6 experiment locally or on production only (never a preview, no scratch table in the shared DB without approval), 3 runs. If it fails, Firia takes row 22 to the founder.
2. **Free-model provider data terms** (2A.6). Owner: Athena. Verify: read Google AI Studio's and Nvidia's terms on the provider-logging page. Doesn't block tests (synthetic only).
3. **OpenRouter behavior when no ZDR endpoint is available** (2.11). Owner: Rudy. Verify: one synthetic call with `zdr:true, only:["anthropic"]` and record status and body.
4. **Whether the free test model routes with Firia's account settings** (Anthropic ZDR on, free-model training setting). Owner: Rudy. Verify: one synthetic preview call to `google/gemma-4-31b-it:free` after Firia's change.
5. **Bedrock and Vertex primary retention terms** (2.8). Owner: Athena. Only matters at the AWS move or with real data.
6. **Push-mode consumers with Fluid compute disabled** (1.8). Owner: Rudy. Check the project's Fluid setting.
7. **Queues GA date and SLA** (1.1/1.9). Owner: Athena. Recheck before the POC exit review.
