/**
 * The founder's rule of 2026-10-17 5:28 PM ET, end to end, on real state:
 *
 *   "Never compensate with a deterministic text parser if the model isn't available; the
 *    owner/staff need to be notified."
 *
 * Three ways for a model to be unavailable, one outcome each, and the outcome is always the same
 * shape: **one staff alert, and nothing else happened**. Each case drives the whole path — the
 * real run loop, the real gateway, the real OpenRouter adapter with `fetch` stubbed, the live
 * executors over a PGlite database with the real migrations — because the claim is not about one
 * function, it is about what the system does to a family's text when the vendor is gone.
 *
 *  (a) **no key** — the adapter's per-call re-check finds `$OPENROUTER_API_KEY` empty;
 *  (b) **call error / 429 on both models** — every model in the chain fails;
 *  (c) **timeout** — our own request deadline fires on both models.
 *
 * What every one of them asserts, and what a deliberately broken alert would fail on:
 *
 *  - the card's **exact copy**, with the guardian named "first name + last initial", the child by
 *    their given name, and the leg word taken from the leg row rather than from the text;
 *  - the parent's words **verbatim**, read back from `ops.message` — not copied into the task;
 *  - **roles**: a director and a coordinator see the alert and the count; the front desk sees
 *    neither. Read through `approvalRoles()`, which reads `src/auth/access.ts`, which this change
 *    does not touch;
 *  - **nothing sent**: no `ops.outbound_message` row at all, and the messaging provider was never
 *    handed anything;
 *  - **nothing proposed**: no `ops.approval_request`, no `ops.change_request`;
 *  - **no ride moved**: every `ops.trip_leg` is byte-identical to how it was seeded;
 *  - the server log line carries the reason class and **no secret** — not the key, not the key's
 *    env value, not a word of the family's message.
 *
 * The happy path that proves these assertions are not vacuous — a model that *is* up, returning a
 * time as structured output — is `modules/approvals/decide.test.ts`. The structural half, that no
 * keyword reader can come back, is `no-keyword-fallback.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { assistantUnavailable } from "@/ui/copy";
import { approvalRoles } from "@/modules/approvals/decide";
import { CHILDREN, FAMILIES, synLegalName } from "@/modules/demo/fixtures/standard";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "./config";
import type { PolicyContext } from "./policy";
import { GatewayError } from "./gateway";
import { type LlmProvider, ProviderError } from "./providers/provider";
import {
  RemoteApiKeyMissing,
  RemoteBaseUrlRefused,
  RemoteEndpointRefused,
  RemoteModelRefused,
  RemoteProviderNotEnabled,
  RemoteProviderUnavailable,
  RemoteRequestUrlRefused,
  remoteProvider,
} from "./providers/remote";
import type { TierFacts } from "./run/context";
import { type LiveHarness, liveHarness } from "./run/exec/live-harness";
import type { Trigger } from "./run/triggers";
import {
  MODEL_UNAVAILABLE_CATEGORY,
  assistantAlertCount,
  modelUnavailableLogLine,
  modelUnavailableReason,
  openAlert,
  openAssistantAlerts,
} from "./staff-alert";

/* ───────────────────────────── the family, and what they wrote ───────────────────────────── */

/** F2 and their child C2 — the pair the founder's copy names. */
const GUARDIAN = FAMILIES.find((f) => f.key === "F2")!.guardian;
const CHILD = CHILDREN.find((c) => c.key === "C2")!;
/** The parent's own sentence. Asserted verbatim, and asserted *absent* from every log line. */
const THEIR_WORDS = "hi, can Noah be dropped off later today? we are running behind";

const PLACEHOLDER_KEY = "placeholder-not-a-key";
const DEMO_ENV = {
  [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
};

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
let env: Record<string, string | undefined>;
let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
  env = { ...DEMO_ENV, OPENROUTER_API_KEY: PLACEHOLDER_KEY };
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  sc = await seedAgentScenario(db, { body: THEIR_WORDS, receivedAt: now });
  // The names a staff screen reads, as a deployment really holds them: the child's label in
  // `ops.child_profile`, the guardian's legal name — ADR-015 marker and all — in the identity
  // schema. The card has to get from those two columns to "Dara O." and "Noah".
  await db.query("UPDATE ops.child_profile SET display_name = $2 WHERE child_token = $1", [
    sc.children[0],
    CHILD.label,
  ]);
  await db.query("UPDATE identity.guardian_contact SET legal_name = $2 WHERE contact_token = $1", [
    sc.contactToken,
    synLegalName(GUARDIAN.firstName, GUARDIAN.lastInitial),
  ]);
  // Mid-afternoon: the morning run is over, so the ride still ahead is the drop-off. The leg word
  // on the card follows *this*, never the words in the message.
  await db.query("UPDATE ops.trip_leg SET state = 'COMPLETED_HANDOFF' WHERE id = $1", [
    sc.legs[sc.children[0]].AM,
  ]);
}, 60_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

/* ───────────────────────────── driving a run with a dead vendor ───────────────────────────── */

const trigger = (): Trigger => ({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId}`,
  t2: `service_date=${sc.serviceDate}`,
  /*
   * The family's words reach the prompt as T3, wrapped untrusted — which is the whole reason a
   * model is being asked at all, and the thing no parser here may read instead.
   *
   * The child's *name* does not: the gateway's `validatePromptTokensOnly` fails closed on an
   * untokenized name (TEST-SEC-01), so a prompt carries the token the operational tables use.
   * The card above goes the other way and shows the family's sentence exactly as they typed it,
   * because a coordinator is reading it. The two are different directions and this test holds
   * both: `t3` is tokenized, `theirWords` is not.
   */
  t3: [THEIR_WORDS.replace(CHILD.firstName, sc.children[0])],
  t4: "channel=SMS locale=en-US",
});

const policy = (): PolicyContext => ({
  scope: sc.scope,
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
});

/**
 * A harness whose provider is the **real** live adapter over the stubbed `fetch`, reading the
 * mutable `env` above. Nothing about the failure is faked at the seam under test: the adapter
 * decides it cannot reach a model, exactly as it would in production.
 *
 * `eager` builds the adapter **now**, while the key is still there, and hands the same instance
 * to every drive. That is the (a) case: `providers/remote.ts` re-checks the key *per call* and
 * not only at wiring time, so an adapter that was wired on a configured deployment and is asked
 * to take a turn after the key has gone refuses from inside `invoke` — which is the path that
 * reaches the run loop and therefore the one that can raise a card.
 */
function harnessWithLiveAdapter(opts: { timeoutMs?: number; eager?: boolean } = {}): LiveHarness {
  const config = loadAgentConfig(DEMO_ENV, { requestTimeoutMs: opts.timeoutMs ?? 10_000 });
  const eager = opts.eager ? remoteProvider(config, env) : null;
  const provider = (): LlmProvider => eager ?? remoteProvider(config, env);
  return liveHarness({ db, script: [], facts: facts(), policy: policy(), now: () => now, provider });
}

/** Everything that would mean the agent *did* something. All of it must be empty. */
async function sideEffects() {
  const count = async (sql: string) =>
    Number((await db.query<{ n: string }>(sql, [])).rows[0].n);
  return {
    outbound: await count("SELECT count(*)::text AS n FROM ops.outbound_message"),
    approvals: await count("SELECT count(*)::text AS n FROM ops.approval_request"),
    changeRequests: await count("SELECT count(*)::text AS n FROM ops.change_request"),
    acknowledgments: await count("SELECT count(*)::text AS n FROM ops.acknowledgment"),
  };
}

/** Every leg, with the two columns a ride change would move. */
async function legs() {
  const r = await db.query<{ id: string; state: string; window_start: Date | null; plan_version: number }>(
    "SELECT id, state, window_start, plan_version FROM ops.trip_leg ORDER BY id",
    [],
  );
  return r.rows;
}

/** The alerts a caller at this site sees. One list, read exactly as the board reads it. */
const alerts = () => openAssistantAlerts(db, [sc.siteId]);

/* ─────────────────────────────── the shared outcome assertions ─────────────────────────────── */

/**
 * What must be true after any model-unavailable run, whatever made the model unavailable.
 *
 * Written once and called from all three cases on purpose: the founder's rule is one rule, and a
 * case that quietly asserted less than the others would be the hole it leaks through.
 */
async function expectNeedsAPersonAndNothingElse(reason: string, legWord: string) {
  // 1. Exactly one alert, and it is a RED `ops.task` of the one category.
  const rows = await db.query<{ id: string; category: string; severity: string; state: string; summary: string; next_step: string; completion_predicate: string; completion_evidence: { locator?: Record<string, unknown> } | null }>(
    "SELECT id, category, severity, state, summary, next_step, completion_predicate, completion_evidence FROM ops.task ORDER BY id",
    [],
  );
  expect(rows.rows).toHaveLength(1);
  const task = rows.rows[0];
  expect(task).toMatchObject({
    category: MODEL_UNAVAILABLE_CATEGORY,
    severity: "RED",
    state: "OPEN",
    summary: assistantUnavailable.task.summary,
    next_step: assistantUnavailable.task.nextStep,
    completion_predicate: assistantUnavailable.task.predicate,
  });
  // The locator points at the message; it does not carry it.
  expect(task.completion_evidence?.locator).toMatchObject({
    message_id: sc.messageId,
    thread_id: sc.threadId,
    reason_class: reason,
  });
  expect(JSON.stringify(task)).not.toContain(THEIR_WORDS);

  // 2. The card, word for word.
  const card = await alerts();
  expect(card).toHaveLength(1);
  expect(card[0].sentence).toBe(
    `${GUARDIAN.firstName} ${GUARDIAN.lastInitial}. texted about ${CHILD.firstName}'s ${legWord}. ` +
      "The assistant couldn't read it. Reply yourself.",
  );
  // And the family's own sentence, unedited, unsummarized, read back from ops.message.
  expect(card[0].theirWords).toBe(THEIR_WORDS);
  expect(card[0].threadId).toBe(sc.threadId);
  expect(card[0].beingHandled).toBe(false);

  // 3. Nothing was sent, nothing was proposed, nothing was acknowledged.
  expect(await sideEffects()).toEqual({
    outbound: 0,
    approvals: 0,
    changeRequests: 0,
    acknowledgments: 0,
  });

  // 4. The log line names the reason class and no secret.
  expect(warn).toHaveBeenCalledTimes(1);
  const logged = String(warn.mock.calls[0][0]);
  expect(logged).toBe(modelUnavailableLogLine(reason as never));
  expect(logged).toContain(reason);
  for (const secret of [PLACEHOLDER_KEY, "OPENROUTER_API_KEY", THEIR_WORDS, CHILD.firstName, GUARDIAN.firstName]) {
    expect(logged, secret).not.toContain(secret);
  }
}

/* ───────────────────────────────────── (a) no key ───────────────────────────────────── */

describe("(a) the deployment has no key: one staff alert, and nothing else", () => {
  it("raises the needs-a-person alert, proposes nothing, changes no ride, sends nothing", async () => {
    const before = await legs();
    // The adapter is wired while a key exists and the key is gone by the time the turn is taken —
    // the per-call re-check in providers/remote.ts is what catches that, and it is the shape of
    // "no key" that a run can actually reach. (A deployment that never had one cannot build the
    // adapter at all, so no run is driven; that is named as a gap in this change's PR body.)
    const h = harnessWithLiveAdapter({ eager: true });
    delete env.OPENROUTER_API_KEY;

    const run = await h.start(trigger());

    expect(run.state).toBe("FAILED");
    expect(run.reason).toContain("model unavailable (no_key)");
    expect(run.reason).toContain("staff alert raised");
    expect(fetchMock).not.toHaveBeenCalled();
    await expectNeedsAPersonAndNothingElse("no_key", assistantUnavailable.legWord.PM);
    expect(await legs()).toEqual(before);
    // No message was ever handed to the provider that would send one.
    expect(h.provider.sent).toEqual([]);
  });
});

/* ──────────────────────── (b) the call errors, and 429 on both models ──────────────────────── */

describe("(b) every model fails: one staff alert, and nothing else", () => {
  it("429 on the primary and the backup raises the alert and sends nothing", async () => {
    const before = await legs();
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const h = harnessWithLiveAdapter();

    const run = await h.start(trigger());

    expect(run.state).toBe("FAILED");
    expect(run.reason).toContain("model unavailable (rate_limited)");
    // Both models were really tried; the chain ended in a refusal, not in a parser.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expectNeedsAPersonAndNothingElse("rate_limited", assistantUnavailable.legWord.PM);
    expect(await legs()).toEqual(before);
    expect(h.provider.sent).toEqual([]);
  });

  it("a transport error on both models raises the same alert", async () => {
    const before = await legs();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const h = harnessWithLiveAdapter();

    const run = await h.start(trigger());

    expect(run.state).toBe("FAILED");
    expect(run.reason).toContain("model unavailable (provider_error)");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expectNeedsAPersonAndNothingElse("provider_error", assistantUnavailable.legWord.PM);
    expect(await legs()).toEqual(before);
    expect(h.provider.sent).toEqual([]);
  });
});

/* ───────────────────────────────────── (c) timeout ───────────────────────────────────── */

describe("(c) the vendor never answers: one staff alert, and nothing else", () => {
  it("our own request deadline on both models raises the alert and sends nothing", async () => {
    const before = await legs();
    // A vendor that accepts the request and says nothing. The promise settles only when the
    // adapter's own AbortController fires, which is what a real hang looks like.
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    );
    const h = harnessWithLiveAdapter({ timeoutMs: 5 });

    const run = await h.start(trigger());

    expect(run.state).toBe("FAILED");
    expect(run.reason).toContain("model unavailable (timeout)");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expectNeedsAPersonAndNothingElse("timeout", assistantUnavailable.legWord.PM);
    expect(await legs()).toEqual(before);
    expect(h.provider.sent).toEqual([]);
  });
});

/* ───────────── what is NOT an outage: a refusal, a stop, and a scripted provider ───────────── */

describe("only a model that could not answer raises a card", () => {
  /**
   * The narrowness of `modelUnavailableReason` is load-bearing, so it is pinned directly. Each of
   * these is an adapter saying "no" for a reason that is not an outage, and a card for any of them
   * would be the wrong answer twice over: it is not a coordinator's job, and "reply to this family
   * yourself" is not the fix.
   */
  it.each([
    ["an endpoint off the allow-list", new RemoteEndpointRefused("endpoint /v1/files refused")],
    ["a base URL nobody vetted", new RemoteBaseUrlRefused("base URL is not https")],
    ["a URL that moved the host", new RemoteRequestUrlRefused("request URL host is not allow-listed")],
    ["a model off the allow-list", new RemoteModelRefused("model vendor-b/x not on the list")],
    ["no demo-data confirmation", new RemoteProviderNotEnabled("set $AGENT_DEMO_DATA_ONLY")],
    ["a scripted provider running out", new ProviderError("fake provider script exhausted")],
  ])("%s is a refusal, not an outage", (_label, err) => {
    expect(modelUnavailableReason(err)).toBeNull();
    // ...and the same through the gateway, which is how the run loop actually sees it.
    expect(modelUnavailableReason(new GatewayError("PROVIDER_ERROR", "refused", { cause: err }))).toBeNull();
  });

  it("every other gateway outcome is the agent refusing correctly, and raises no card", () => {
    for (const outcome of [
      "REJECTED_FREE_TEXT",
      "REJECTED_PROMPT_LEAK",
      "REJECTED_INVALID_ARGS",
      "REJECTED_RATE_LIMIT",
      "REJECTED_UNKNOWN_TOOL",
    ] as const) {
      expect(modelUnavailableReason(new GatewayError(outcome, outcome)), outcome).toBeNull();
    }
  });

  it("the two classes that do mean an outage still do, with and without a gateway", () => {
    const noKey = new RemoteApiKeyMissing("$OPENROUTER_API_KEY is not set in this environment");
    expect(modelUnavailableReason(noKey)).toBe("no_key");
    expect(modelUnavailableReason(new GatewayError("PROVIDER_ERROR", "x", { cause: noKey }))).toBe("no_key");

    const attempt = (failure: "timeout" | "rate_limited" | "http_error") =>
      ({ model: "m", status: null, ok: false, failure }) as const;
    expect(modelUnavailableReason(new RemoteProviderUnavailable("x", [attempt("timeout"), attempt("timeout")]))).toBe(
      "timeout",
    );
    expect(
      modelUnavailableReason(new RemoteProviderUnavailable("x", [attempt("rate_limited"), attempt("rate_limited")])),
    ).toBe("rate_limited");
    // A mixed chain is neither of the two an on-call would act on differently.
    expect(
      modelUnavailableReason(new RemoteProviderUnavailable("x", [attempt("timeout"), attempt("http_error")])),
    ).toBe("provider_error");
    // And an unclassified transport failure from any adapter is an outage.
    expect(modelUnavailableReason(new GatewayError("PROVIDER_ERROR", "x", { cause: new TypeError("fetch failed") }))).toBe(
      "provider_error",
    );
  });
});

/* ──────────────────────────────── who sees it, and who does not ──────────────────────────────── */

describe("roles: only a director or a coordinator sees the alert or its count", () => {
  it("the access table's /exceptions row is the whole rule, and the front desk is not in it", () => {
    // Asserted against `approvalRoles()` rather than a list written here, because the list here
    // is exactly the thing that could drift from `src/auth/access.ts` — which this change does
    // not touch.
    expect([...approvalRoles()].sort()).toEqual(["COORDINATOR", "DIRECTOR"]);
    expect(approvalRoles()).not.toContain("FRONT_DESK");
  });

  it("a caller with no membership at the site reads no alerts and a count of zero", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await harnessWithLiveAdapter().start(trigger());

    // The front desk cannot open /exceptions at all, so the board never asks on their behalf —
    // and the reads themselves are site-scoped, so an empty site list is an empty answer. Both
    // halves matter: the page guard is the door, and this is the lock behind it.
    expect(await openAssistantAlerts(db, [])).toEqual([]);
    expect(await assistantAlertCount(db, [])).toBe(0);
    // A site this caller is not a member of is not "forbidden", it is simply not selected.
    expect(await openAssistantAlerts(db, ["00000000-0000-7000-8000-0000000000b1"])).toEqual([]);
    expect(await assistantAlertCount(db, ["00000000-0000-7000-8000-0000000000b1"])).toBe(0);
    // And a member of the real site sees exactly one.
    expect(await assistantAlertCount(db, [sc.siteId])).toBe(1);
  });
});

/* ────────────────────── the alert's own lifecycle: one card, and it stays ────────────────────── */

describe("the alert is one card, and opening it marks it taken rather than hiding it", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
  });

  it("a re-driven run does not raise a second alert for the same text", async () => {
    const h = harnessWithLiveAdapter();
    const first = await h.start(trigger());
    await h.drive(first.runId);
    await h.drive(first.runId);

    expect(await assistantAlertCount(db, [sc.siteId])).toBe(1);
  });

  it("opening it moves OPEN → IN_PROGRESS, and the card is still on the board", async () => {
    await harnessWithLiveAdapter().start(trigger());
    const [card] = await alerts();

    expect(await openAlert(db, { id: card.id, siteIds: [sc.siteId], by: "staff:test" })).toEqual({
      claimed: true,
    });

    const after = await alerts();
    expect(after).toHaveLength(1);
    expect(after[0].state).toBe("IN_PROGRESS");
    expect(after[0].beingHandled).toBe(true);
    // It did not disappear on its own: the family is still waiting, so it still counts.
    expect(await assistantAlertCount(db, [sc.siteId])).toBe(1);

    // A second opener is told they were not the one who took it.
    expect(await openAlert(db, { id: card.id, siteIds: [sc.siteId], by: "staff:other" })).toEqual({
      claimed: false,
    });
  });

  it("another tenant cannot open it", async () => {
    await harnessWithLiveAdapter().start(trigger());
    const [card] = await alerts();
    expect(
      await openAlert(db, { id: card.id, siteIds: ["00000000-0000-7000-8000-0000000000b1"], by: "staff:elsewhere" }),
    ).toEqual({ claimed: false });
    expect((await alerts())[0].state).toBe("OPEN");
  });
});

/* ───────────────────── the leg word comes from the rows, never from the text ───────────────────── */

describe("the leg word is read off the leg, not out of the family's sentence", () => {
  it("with the morning run still ahead, the same text produces a pick-up card", async () => {
    // The message says "dropped off" in so many words. The card says "pick-up", because the AM
    // leg has not run yet — which is the whole point: nothing here reads the sentence.
    await db.query("UPDATE ops.trip_leg SET state = 'SCHEDULED' WHERE id = $1", [
      sc.legs[sc.children[0]].AM,
    ]);
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await harnessWithLiveAdapter().start(trigger());

    const [card] = await alerts();
    expect(card.sentence).toContain(assistantUnavailable.legWord.AM);
    expect(card.sentence).not.toContain(assistantUnavailable.legWord.PM);
  });
});
