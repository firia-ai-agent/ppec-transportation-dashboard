# Vercel Queues delayed delivery + OpenRouter ZDR routing for Claude Sonnet

Author: Athena (research lead). Research only, no app code. All sources checked **2026-10-14** (ET) unless noted.
Labels: **Verified** (primary source URL), **Contradicted**, **Unverified**. Every item is also tagged with a decision status: **Proposed** means it's a recommendation only, and nothing here changes a ledger row.

Locks respected (not reopened): POC on Vercel + Neon, AWS later (ledger row 3); one Neon database per environment, never shared (row 19); live agent through OpenRouter on synthetic data only (row 4); model is Claude Sonnet (current) via OpenRouter with `zdr:true` (row 14); Auth.js (row 8). Timer contingency Upstash QStash is still **Proposed** and needs founder sign-off (row 22). This doc doesn't change it.

## One-screen summary

1. **Vercel Queues is public beta, not GA.** It's available on all plans (Hobby includes the first 1M operations), and push consumers run on Fluid compute. Delays are **integer seconds**, from 0 up to 7 days, capped at the message TTL (60 s to 7 days, default 24 h).
2. **No published accuracy or SLA for when a delayed message is actually delivered.** Vercel says nothing on how closely delays are honored. Delivery is at-least-once, there's no FIFO, and failed messages retry (default 60 s, forced backoff after 32 attempts). PRD NFR-03 ("fire ≤5 s late, exactly once") **can't be claimed from docs**. It has to be measured: see the PROPOSED experiment in §1.6, which feeds the existing TEST-INF-01 / row 22 gate.
3. **"Exactly once" must come from our DB, not the queue.** Keep the `claimed_until` lease plus idempotent handlers (row 25). The Queues visibility timeout (API default 60 s; SDK default 300 s with auto-extend) is a separate lease and doesn't replace the job lease.
4. **OpenRouter can restrict Sonnet to ZDR endpoints.** `provider.zdr: true` (per request) ORs with account and guardrail ZDR. For current Sonnet (`anthropic/claude-sonnet-5.5`), the ZDR endpoints are **Amazon Bedrock and Google Vertex only**. The Anthropic first-party, Azure and "Claude Platform on AWS" endpoints aren't on the ZDR list, so `zdr:true` excludes them. Anthropic's own API retains inputs and outputs for up to 30 days.
5. **OpenRouter has no BAA** (its own statement). ZDR isn't HIPAA. Synthetic data only stays mandatory (row 4). PROPOSED config is in §2.5: `zdr:true`, `data_collection:"deny"`, `only:["amazon-bedrock","google-vertex"]`, `allow_fallbacks:false`, a pinned model slug and no `models` fallback list.

**What changes Rudy's build now:** (a) don't rely on Queues for exactly-once or for the ≤5 s bar until TEST-INF-01 measures it; (b) the OpenRouter call must pin the model slug and send the §2.5 `provider` block; (c) `deliveryCount > 1` must be treated as normal (idempotency).

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
- On the synthetic production deployment (row 18 already allows TEST-INF-01 there) and on one preview: publish N=300 messages with `delaySeconds` ∈ {3, 60, 900, 3600} (75 each), payload `{sentAtMs, delaySeconds, id}`, plus an idempotency key.
- The consumer records `receivedAtMs - (sentAtMs + delay*1000)` (lateness), `deliveryCount`, and duplicates by `id` into a scratch table (synthetic only).
- Also run 20 messages where the handler throws once, to measure retry-to-redelivery time with `retryAfterSeconds` set to 1 s.
- Report p50, p95, p99 and max lateness, early deliveries (lateness < 0), duplicate rate, and any losses. **Pass bar = NFR-03: p100 ≤ 5 s late** across 3 runs (matching TEST-INF-01's 3 recorded runs). If it fails, row 22 (QStash, Proposed) goes to the founder; this doc doesn't decide that.

### 1.7 What this means for the PRD's timed jobs
- **NFR-03 (PRD l.513–514, "fire ≤5 s late, exactly once")**: neither half is guaranteed by Vercel docs. Exactly-once must come from the DB lease (`claimed_until`, row 25) plus idempotent effects (outbound state machine, row 28). ≤5 s is a measurement, not a documented property (1.9).
- **3 s vs 60 s lease**: this is our **DB job lease**, a separate decision from the Queues visibility timeout. (Veri's #17 review notes main is still on 60 s and the 3 s change lives in unmerged #10; that's ledger business, not reopened here.) Facts relevant to it: a 60 s DB lease means a crashed claim is retried by the sweeper up to ~60 s late, which breaks the 5 s bar for that job on its own; a 3 s lease needs handlers that finish or renew inside 3 s. The Queues default `retryAfterSeconds` (60 s) and API visibility timeout (60 s) would likewise put a failed delivery ~60 s late unless lowered. Whichever lease is chosen, set `retryAfterSeconds` and the visibility timeout to match it. **Proposed.**
- **Reminders (PRD l.284: T−90 request, T−60 reminder, T−45 escalation, T−30/−15/−5 readiness)**: these are all well under the 7-day max delay, so a single delayed message fits. Because there's no FIFO and redelivery is possible, each handler must re-check current state (cancelled, already sent, plan version) at fire time before sending. Anything scheduled more than 7 days out needs the cron sweep or daisy-chaining (concepts page). **Proposed.**
- **Deployment pinning**: messages stay with the publishing deployment, so a preview's delayed jobs fire in the preview, and an old prod deployment keeps consuming its in-flight messages after a promote. Set `maxDeliveries` so a stale deployment stops retrying. This matters for the preview-isolation work (#18 and #20). **Proposed.**

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

### 2.5 PROPOSED request config for Rudy
**Status: Proposed.** It implements locked row 14 (`zdr:true`) and doesn't change it.
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
- Pin the exact slug, not `~anthropic/claude-sonnet-latest`, so a model change is a deliberate PR. Don't send `models: [...]`.
- Account side (founder or Firia in OpenRouter settings; the key stays in Vercel env per row 20): turn on ZDR for the **Anthropic** group, and ideally all groups. Keep prompt logging off.
- On 404 or no endpoints, treat it as a hard failure and show the agent as unavailable or hand off to staff. **Never retry without `zdr`.**
- Add a unit test asserting the outbound body always contains `provider.zdr === true` and `allow_fallbacks === false`.

---

## Ranked Unverified list (owner / how to verify)

1. **Delay accuracy (≤5 s, NFR-03)**. Owner: Rudy (run), Veri (review). Verify: run the §1.6 experiment as part of TEST-INF-01 for 3 runs. If it fails, Firia takes row 22 to the founder.
2. **OpenRouter behavior when no ZDR endpoint is available** (2.11). Owner: Rudy. Verify: one synthetic call with `zdr:true, only:["anthropic"]` (Anthropic isn't ZDR) and record the status and body; then make the handler match.
3. **Bedrock and Vertex primary retention terms** (2.8). Owner: Athena. Verify: read the AWS Bedrock data-protection docs and the Google Vertex AI zero-data-retention docs; record any abuse-monitoring logging. This only matters at the AWS move or with real data.
4. **Push-mode consumers with Fluid compute disabled** (1.8). Owner: Rudy. Verify: check the project's Fluid setting in Vercel. If Fluid is on, this is moot; otherwise test-deploy one consumer to a preview.
5. **Queues GA date and SLA** (1.1/1.9). Owner: Athena. Verify: recheck the Queues docs and changelog before the POC exit review.
