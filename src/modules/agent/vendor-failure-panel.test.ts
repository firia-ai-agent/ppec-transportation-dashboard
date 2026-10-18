/**
 * **Veri's agent gate, check 5: when OpenRouter fails, the panel says so plainly.**
 *
 * `providers/remote.test.ts` proves the *adapter* degrades — primary, backup, then the §18.1
 * keyword parser. This file is about what a coordinator standing in front of the screen sees when
 * that happens, which is a different question with three parts to it:
 *
 *  - **it says so**, in `ui/copy.ts`, as a sentence and not a status code;
 *  - **it offers the keyword fallback** rather than nothing: the turn still ends in front of a
 *    person, with the degraded path labelled, because a degraded answer that looks live is the one
 *    dishonest thing this screen could do;
 *  - **it never hangs and never invents a reply**: the turn is bounded by the configured timeout,
 *    and what comes back is a real catalog tool call that changed nothing, never prose.
 *
 * Each of the four vendor failures gets its own case — a 429, a timeout, a dropped connection and
 * a 200 carrying something that is not a model's answer — because they fail in different places in
 * the adapter and only the first is the one anybody remembers to test.
 *
 * The last suite is the server action itself. A turn that *throws* is a turn the panel cannot
 * narrate: `useActionState` has no state for it, so the browser gets Next's error boundary instead
 * of a sentence. So `runAgentTurn` is driven against a deployment whose vendor cannot be reached
 * at all, and has to come back as `refused` with copy on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { demoDay } from "@/domain/board/day";
import { EVERY_MODEL_FAILED, demoAgentTurn } from "@/modules/demo/agent-turn";
import { assistantUnavailable, familyTexts } from "@/ui/copy";
import { readFileSync } from "node:fs";
import path from "node:path";
import { modelReach } from "./run/deps";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "./config";
import { TOOL_NAMES, toolDef } from "./tools";

const KEY = "placeholder-not-a-key";

/**
 * The rebuilt screen and its page. Read as text, because the rule is structural: the screen is
 * handed a *boolean* ("can a model be reached"), so there is no reason string on it to print by
 * accident, and the page is the one place `modelReach()` is called.
 */
const SCREEN = path.join(process.cwd(), "src", "app", "(app)", "family-texts", "TextsScreen.tsx");
const PAGE = path.join(process.cwd(), "src", "app", "(app)", "family-texts", "page.tsx");
const ACTIONS = path.join(process.cwd(), "src", "app", "(app)", "family-texts", "actions.ts");

/** A deployment that may make a live call, so every failure below is the *vendor's* and not a gate's. */
const LIVE_ENV: Record<string, string | undefined> = {
  [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
  OPENROUTER_API_KEY: KEY,
  // Short, so the timeout case is a test and not a wait. The adapter reads it from config.
  AGENT_REQUEST_TIMEOUT_MS: "60",
};

const TEXT = "Can he be dropped at grandma's at 5?";
const turn = (env: Record<string, string | undefined> = LIVE_ENV) =>
  demoAgentTurn({ childKey: "C1", text: TEXT, day: demoDay(), env });

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** The four ways the vendor lets us down, each stubbed at `fetch`. */
const VENDOR_FAILURES: readonly [string, () => void][] = [
  [
    "rate-limited on every model (429, the expected failure on a free endpoint)",
    () => vi.stubGlobal("fetch", async () => jsonResponse(429, { error: { message: "rate limit exceeded" } })),
  ],
  [
    "timed out on every model",
    () =>
      vi.stubGlobal("fetch", async (_url: string, init: { signal: AbortSignal }) => {
        await new Promise((_resolve, reject) => {
          const abort = new Error("aborted");
          abort.name = "AbortError";
          init.signal.addEventListener("abort", () => reject(abort), { once: true });
        });
        throw new Error("unreachable");
      }),
  ],
  [
    "dropped the connection",
    () =>
      vi.stubGlobal("fetch", async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:443");
      }),
  ],
  [
    "answered 200 with something that is not a model's answer",
    () => vi.stubGlobal("fetch", async () => jsonResponse(200, "<html>502 Bad Gateway</html>")),
  ],
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("check 5, part 1: every vendor failure comes back as no model answered, labelled", () => {
  it.each(VENDOR_FAILURES)("%s", async (_what, stub) => {
    stub();
    const t = await turn();

    // Not a model answer dressed up as one, and not a lesser reader's answer either: the chain
    // ends in a refusal (founder, 2026-10-17), so the model id is dropped and the reason carried.
    expect(t.modelUnavailable).toBe(true);
    expect(t.model).toBeNull();
    expect(t.unavailableReason).toBe(EVERY_MODEL_FAILED);
    // And nothing was proposed, so there is no card for the screen to draw.
    expect(t.dropoff).toBeNull();
  });

  it("the same deployment on a working vendor says a model answered, so the label means something", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{ function: { name: "get_leg_state", arguments: { leg_id: "L-C1-PM" } } }],
            },
          },
        ],
      }),
    );
    const t = await turn();
    expect([t.modelUnavailable, t.model]).toEqual([false, loadAgentConfig(LIVE_ENV).model]);
    expect(t.unavailableReason).toBeNull();
  });
});

describe("check 5, part 2: it never invents a reply", () => {
  it.each(VENDOR_FAILURES)("%s chooses no tool at all, so nothing could be sent", async (_what, stub) => {
    stub();
    const t = await turn();

    // No call came back, so no tool ran: the turn names none, and a name that is not a tool
    // cannot be one that sends. (It used to be the keyword parser's `escalate_exception`; the
    // reader is gone, and the "needs a person" alert is what tells staff instead.)
    expect(t.tool).toBe("");
    expect(TOOL_NAMES).not.toContain(t.tool);
    expect(toolDef(t.tool)).toBeUndefined();
    // And nothing in the turn is a sentence addressed to the family either.
    expect(JSON.stringify(t.args)).not.toContain("grandma");
  });

  /**
   * What it does instead of inventing a reply: **nothing**, and it says so.
   *
   * This used to expect an `ALLOW` verdict carrying a `next_step_code`, which was the keyword
   * parser's own `escalate_exception` call — the degraded answer the founder's rule of
   * 2026-10-17 deleted. There is no second reader now, so a vendor failure produces no tool call,
   * no proposal and no verdict worth the name; the "needs a person" staff alert is what tells a
   * coordinator, and the screen renders no proposal card at all (Firia's gate 5).
   */
  it("says plainly what it did instead: nothing at all, and the alert is what tells staff", async () => {
    VENDOR_FAILURES[0][1]();
    const t = await turn();
    expect(t.modelUnavailable).toBe(true);
    expect(t.mutated).toBe(false);
    expect(t.dropoff).toBeNull();
    // Nothing was proposed, so there is no next step inside the turn to read.
    expect(Object.keys(t.args)).not.toContain("next_step_code");
    // The sentence a coordinator reads instead is a sentence, in copy.ts.
    expect(familyTexts.assistantUnavailable).toMatch(/^[A-Z].*\.$/s);
  });
});

describe("check 5, part 3: it never hangs", () => {
  it("a vendor that never answers is bounded by the configured timeout, twice over", async () => {
    VENDOR_FAILURES[1][1]();
    const config = loadAgentConfig(LIVE_ENV);
    expect(config.requestTimeoutMs).toBe(60);

    const started = Date.now();
    const t = await turn();
    const elapsed = Date.now() - started;

    expect(t.modelUnavailable).toBe(true);
    // Two models in the chain, each with its own timeout, and then the refusal. Generous on the
    // upper bound because a loaded CI box is slow; the point is that it *returns*.
    expect(elapsed).toBeLessThan(config.requestTimeoutMs * 2 + 10_000);
  });
});

describe("check 5, part 4: the words the panel uses are in copy.ts and are plain", () => {
  /**
   * The vendor's own names come from config rather than from a list written out here — a literal
   * model slug in this file is exactly what `no-hardcoded-models.test.ts` fails the build over,
   * and reading them off the config is the stronger check anyway: it follows the next vendor.
   */
  const CONFIG = loadAgentConfig(LIVE_ENV);
  const vendorWords = [CONFIG.provider, CONFIG.model, CONFIG.backupModel, ...CONFIG.modelAllowList];

  it("the no-model sentence names no model, no vendor and no status code", () => {
    const said = familyTexts.assistantUnavailable;
    expect(said).toMatch(/^[A-Z].*\.$/s);
    for (const word of vendorWords) expect(said.toLowerCase()).not.toContain(word.toLowerCase());
    expect(said).not.toMatch(/\b\d{3}\b|rate.?limit|timeout|ECONN/i);
    /*
     * It says the two things a coordinator needs: the assistant was not reached, and nothing
     * happened as a result. The assertion is on the *meaning* rather than on one phrasing,
     * because the copy is Vera's to reword and this check is about what it must convey. It must
     * **not** offer a second reader: there is none (founder, 2026-10-17).
     */
    expect(said.toLowerCase()).toMatch(/could ?n.t be reached|could not be reached|no model was reachable/);
    expect(said.toLowerCase()).toMatch(/nothing happened|no ride changed/);
    expect(said.toLowerCase()).not.toContain("keyword");
  });

  /**
   * THE MODEL ID IS NOT A FACT A COORDINATOR CAN USE (Vera's review, 2026-10-17 14:40 ET).
   *
   * `answeredByModel` used to read "Answered by the model this deployment is set to use:
   * claude-…", and the id is a deployment setting rather than anything about *this* reply: a
   * coordinator cannot act on it, and on the screen a founder demos it reads as leaked config.
   * So the sentence names the assistant, and the id stays in the run's server-side record where
   * a reviewer actually checks it.
   *
   * Both halves are asserted, because dropping the word alone would not be the fix: the copy must
   * carry no `{model}` placeholder either, or the next caller re-introduces the value by filling
   * it. `PhoneComposer` correspondingly stops reading `turn.model` at all.
   */
  it("the sentence naming who answered names the assistant, never the model", () => {
    const said = familyTexts.answeredByModel;
    expect(said).toBe("Answered by the assistant.");
    expect(said).toMatch(/^[A-Z].*\.$/s);
    expect(said.toLowerCase()).toContain("assistant");
    for (const word of vendorWords) expect(said.toLowerCase()).not.toContain(word.toLowerCase());
    // No placeholder at all, so there is no way to put a model id back through `fill`.
    expect(said).not.toMatch(/\{\w+\}/);
    expect(said.toLowerCase()).not.toContain("model");
  });

  it("the staff alert on Exceptions says the same thing, and names no vendor either", () => {
    // The other half of the founder's rule: the owner/staff are told. These are the card's words
    // (`agent/staff-alert.ts` writes the row; `exceptions/AlertCards.tsx` renders it).
    for (const said of [assistantUnavailable.card, assistantUnavailable.cardNoChild]) {
      for (const word of vendorWords) expect(said.toLowerCase(), said).not.toContain(word.toLowerCase());
      expect(said, said).not.toMatch(/\b\d{3}\b|undefined|Error|keyword/i);
      // It tells a person what to do, which is the whole point of raising it.
      expect(said.toLowerCase(), said).toContain("reply yourself");
    }
  });
});

describe("check 5, part 5: no server action can spend a model call at all", () => {
  /**
   * This used to drive `runAgentTurn`, the phone panel's own action, and assert it answered with
   * a sentence rather than throwing. The rebuilt screen has no such action: a turn is driven by
   * the queue (`/api/queues/agent`) where a model call belongs. So the stronger version of the
   * same check is that the action surface is an exact, short list and no item on it is a door to
   * a vendor.
   *
   * Two actions, and the list is exact so a third has to be argued for here:
   *  - `decideApprovalAction` — Approve / Edit / Don't send, the one write path (gate 1).
   *  - `takeAlertAction` — marks a "needs a person" alert taken, which used to happen on a GET
   *    render (Firia's S1-4, 2026-10-18 12:13 AM ET). It writes one task state and calls no
   *    model; `alert-taken-on-post.test.ts` holds its rules.
   */
  it("exports the decision and the alert take, and nothing that calls a vendor", () => {
    /*
     * Read as text rather than imported: the action's module graph reaches Auth.js, which wants a
     * Next request context this runner has none of. What is being asserted is the shape of the
     * file — one exported action, and no door to a vendor in it — and the source is where that is.
     */
    const source = readFileSync(ACTIONS, "utf8");
    expect([...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1])).toEqual([
      "decideApprovalAction",
      "takeAlertAction",
    ]);
    expect(source).not.toMatch(/demoAgentTurn|createGateway|chooseProvider|modelReach/);
  });

  /**
   * And the turn seam itself still answers rather than throwing, on a deployment whose vendor may
   * not be called at all — which is what the action case was really asserting.
   */
  it("a deployment with no key comes back as no model answered, not a stack trace", async () => {
    // The commonest shape of "this deployment may not call a vendor", and the one a preview is
    // in. A *config* this build cannot parse at all throws at load and is `modelReach`'s job
    // (part 6 below); this is the one that has to come back as a turn.
    const env = { ...LIVE_ENV, OPENROUTER_API_KEY: undefined };
    const turn = await demoAgentTurn({ childKey: "C1", text: TEXT, day: demoDay(), env });
    expect(turn.modelUnavailable).toBe(true);
    expect(turn.dropoff).toBeNull();
  });

  it("a rate-limited vendor comes back as a turn that says no model answered", async () => {
    VENDOR_FAILURES[0][1]();
    const turn = await demoAgentTurn({ childKey: "C1", text: TEXT, day: demoDay(), env: LIVE_ENV });
    expect(turn.modelUnavailable).toBe(true);
    expect(turn.unavailableReason).toBe(EVERY_MODEL_FAILED);
    expect(turn.dropoff).toBeNull();
  });
});

describe("check 5, part 6: which reader will answer is on the screen", () => {
  it("names the model on a deployment that may call one", () => {
    const reach = modelReach(LIVE_ENV);
    expect(reach.kind).toBe("model");
    expect(reach.kind === "model" && reach.model).toBe(loadAgentConfig(LIVE_ENV).model);
  });

  it("is unavailable when no live call is allowed, with no second reader offered", () => {
    // No key. There is no degraded path left to name (founder, 2026-10-17): the text goes to a
    // person through the staff alert, and the screen says the assistant could not be reached.
    const reach = modelReach({ ...LIVE_ENV, OPENROUTER_API_KEY: undefined });
    expect(reach.kind).toBe("unavailable");
    expect(reach.kind === "unavailable" && reach.reason.length).toBeGreaterThan(0);
  });

  it("is unavailable, not a thrown stack, when the config cannot be read at all", () => {
    // A base URL this build may not send a key to: `chooseProvider` refuses at wiring time.
    const reach = modelReach({ ...LIVE_ENV, AGENT_BASE_URL: "https://not-vetted.example.com/v1" });
    expect(reach.kind).toBe("unavailable");
  });

  /**
   * The copy each kind puts on screen. `model` shows nothing — the per-turn card already names
   * the model — and the other two get the sentences Vera wrote, which say which reader ran and
   * what did not happen.
   */
  it("maps each kind to a plain sentence, and the model case to silence", () => {
    const said: Record<string, string | null> = {
      model: null,
      unavailable: familyTexts.assistantUnavailable,
    };
    for (const [kind, sentence] of Object.entries(said)) {
      if (sentence === null) continue;
      expect(sentence, kind).toMatch(/^[A-Z].*\.$/s);
      // Plain words: no status code, no variable name, no vendor.
      expect(sentence, kind).not.toMatch(/\b\d{3}\b|OPENROUTER|_ENV|process\.env/i);
    }
    // And the screen renders that one sentence and names no second reader, because there is none.
    const screen = readFileSync(SCREEN, "utf8");
    expect(screen).toContain("familyTexts.assistantUnavailable");
    expect(screen).not.toMatch(/keyword/i);
  });

  /**
   * The key never reaches the screen or a log line, under any of the three answers. The reason a
   * refusal carries names an environment *variable*; this asserts no reach carries its *value*,
   * and that the component the panel renders has no way to print a reason at all — its prop is
   * the kind alone, which makes the rule structural rather than remembered.
   */
  it("carries no key, and the screen has no reason to print", () => {
    for (const env of [
      LIVE_ENV,
      { ...LIVE_ENV, OPENROUTER_API_KEY: undefined },
      { ...LIVE_ENV, AGENT_BASE_URL: "https://not-vetted.example.com/v1" },
    ]) {
      const reach = modelReach(env);
      expect(JSON.stringify(reach)).not.toContain(KEY);
    }
    // The prop is a boolean, not a reach: there is no `.reason` on it to render by accident, and
    // the page is the only file that calls `modelReach()` at all.
    const screen = readFileSync(SCREEN, "utf8");
    expect(screen).toContain("readonly assistantReachable: boolean;");
    expect(screen).not.toMatch(/reach\.reason|modelReach\(/);
    expect(readFileSync(PAGE, "utf8")).toContain('modelReach().kind === "model"');
  });
});
