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
import { familyTexts } from "@/ui/copy";
import { readFileSync } from "node:fs";
import path from "node:path";
import { modelReach } from "./run/deps";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "./config";
import { TOOL_NAMES, toolDef } from "./tools";

const KEY = "placeholder-not-a-key";

/** The client component that renders the notice. Read as text: it must have no reason to print. */
const COMPOSER = path.join(process.cwd(), "src", "app", "(app)", "family-texts", "PhoneComposer.tsx");

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

describe("check 5, part 1: every vendor failure lands on the keyword fallback, labelled", () => {
  it.each(VENDOR_FAILURES)("%s", async (_what, stub) => {
    stub();
    const t = await turn();

    expect(t.source).toBe("keyword");
    // Not a model answer dressed up as one: the model id is dropped and the reason is carried.
    expect(t.model).toBeNull();
    expect(t.degradedReason).toBe(EVERY_MODEL_FAILED);
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
    expect([t.source, t.model]).toEqual(["model", loadAgentConfig(LIVE_ENV).model]);
    expect(t.degradedReason).toBeNull();
  });
});

describe("check 5, part 2: it never invents a reply", () => {
  it.each(VENDOR_FAILURES)("%s produces a catalog tool call that changed nothing", async (_what, stub) => {
    stub();
    const t = await turn();

    // A real tool from the §11.2 catalog — the keyword parser's escalation — and not prose.
    expect(TOOL_NAMES).toContain(t.tool);
    expect(t.tool).toBe("escalate_exception");
    // It raises a staff exception; what it is *not* is a tool that puts anything in front of a
    // family. A degraded turn that answered the parent would be the invented reply.
    expect(toolDef(t.tool)!.effect).not.toBe("send");
    // And nothing in the turn is a sentence addressed to the family either.
    expect(JSON.stringify(t.args)).not.toContain("grandma");
  });

  it("says plainly what it did instead: raised it for a person", async () => {
    VENDOR_FAILURES[0][1]();
    const t = await turn();
    expect(t.verdict).toBe("ALLOW");
    expect(String(t.args.next_step_code)).toMatch(/^[A-Z_]+$/);
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

    expect(t.source).toBe("keyword");
    // Two models in the chain, each with its own timeout, and then the keyword parser. Generous
    // on the upper bound because a loaded CI box is slow; the point is that it *returns*.
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

  it("the degraded sentence names no model, no vendor and no status code", () => {
    const said = familyTexts.answeredByKeyword;
    expect(said).toMatch(/^[A-Z].*\.$/s);
    for (const word of vendorWords) expect(said.toLowerCase()).not.toContain(word.toLowerCase());
    expect(said).not.toMatch(/\b\d{3}\b|rate.?limit|timeout|ECONN/i);
    /*
     * It says the two things a coordinator needs, in Vera's words (2026-10-17): the model was not
     * reached, and the keyword reader is what answered instead. The assertion is on the *meaning*
     * rather than on one phrasing — "couldn't reach its model" and "no model was reachable" both
     * pass — because the copy is Vera's to reword and this check is about what it must convey.
     */
    expect(said.toLowerCase()).toMatch(/could ?n.t reach its model|no model was reachable/);
    expect(said.toLowerCase()).toContain("keyword");
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

  it("the refusal sentence for a vendor that cannot be reached at all is prose too", () => {
    const said = familyTexts.assistantUnavailable;
    expect(said).toMatch(/^[A-Z].*\.$/s);
    for (const word of vendorWords) expect(said.toLowerCase()).not.toContain(word.toLowerCase());
    expect(said).not.toMatch(/\b\d{3}\b|undefined|Error/i);
    // And it says what did not happen, which is the thing a coordinator has to know.
    expect(said.toLowerCase()).toMatch(/nothing|no ride|not sent/);
  });
});

describe("check 5, part 5: the server action answers with that sentence instead of throwing", () => {
  /** A coordinator who may open the panel: the access check is not what this suite is about. */
  beforeEach(() => {
    vi.doMock("@/auth/caller", () => ({ getCaller: async () => ({ kind: "staff" }) }));
    vi.doMock("@/auth/access", () => ({ canOpenPage: () => true }));
  });

  const form = (text: string) => {
    const f = new FormData();
    f.set("child", "C1");
    f.set("text", text);
    return f;
  };

  it("a vendor this deployment may not call at all comes back as a refusal, not a stack trace", async () => {
    // A base URL off the host allow-list: `chooseProvider` throws rather than degrading, because
    // "the key nearly went somewhere nobody vetted" is a stop and not a fallback (remote.ts).
    const env = { ...LIVE_ENV, AGENT_BASE_URL: "https://evil.example" };
    const saved = process.env;
    process.env = { ...saved, ...env } as NodeJS.ProcessEnv;
    try {
      const { runAgentTurn } = await import("@/app/(app)/family-texts/actions");
      const state = await runAgentTurn({ status: "idle" }, form(TEXT));
      expect(state.status).toBe("refused");
      expect(state.status === "refused" ? state.message : "").toBe(familyTexts.assistantUnavailable);
    } finally {
      process.env = saved;
    }
  });

  it("a rate-limited vendor still comes back as an answered turn, on the degraded path", async () => {
    VENDOR_FAILURES[0][1]();
    const saved = process.env;
    process.env = { ...saved, ...LIVE_ENV } as NodeJS.ProcessEnv;
    try {
      const { runAgentTurn } = await import("@/app/(app)/family-texts/actions");
      const state = await runAgentTurn({ status: "idle" }, form(TEXT));
      expect(state.status).toBe("answered");
      if (state.status !== "answered") return;
      expect(state.turn.source).toBe("keyword");
      expect(state.turn.degradedReason).toBe(EVERY_MODEL_FAILED);
    } finally {
      process.env = saved;
    }
  });
});

/**
 * check 5, part 6: THE SCREEN SAYS IT, NOT ONLY THE SERVER LOG (Vera's review, 2026-10-17).
 *
 * Parts 1–5 are about one turn: a coordinator types a text, the vendor fails, and the card under
 * it is labelled. What was missing is the state *before* anybody types. The queue route logged
 * "degraded provider (…)" per delivery and no screen said anything, so a deployment whose model
 * was unreachable looked perfectly healthy: the keyword reader's answer arrived with no sign that
 * no model had ever seen the text, and the one place that knew was a log nobody at a demo reads.
 *
 * `modelReach` is the answer to "which reader will answer here", and it is one function so that
 * the log line and the sentence on screen cannot disagree. These hold the three answers, the
 * sentence each one puts on screen, and the rule that the refusal's own words never get there.
 */
describe("check 5, part 6: which reader will answer is on the screen", () => {
  it("names the model on a deployment that may call one", () => {
    const reach = modelReach(LIVE_ENV);
    expect(reach.kind).toBe("model");
    expect(reach.kind === "model" && reach.model).toBe(loadAgentConfig(LIVE_ENV).model);
  });

  it("is the keyword reader, by name, when no live call is allowed", () => {
    // No key: the §18.1 degraded path, which still ends in front of a person.
    const reach = modelReach({ ...LIVE_ENV, OPENROUTER_API_KEY: undefined });
    expect(reach.kind).toBe("keyword");
    expect(reach.kind === "keyword" && reach.reason.length).toBeGreaterThan(0);
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
      keyword: familyTexts.answeredByKeyword,
      unavailable: familyTexts.assistantUnavailable,
    };
    for (const [kind, sentence] of Object.entries(said)) {
      if (sentence === null) continue;
      expect(sentence, kind).toMatch(/^[A-Z].*\.$/s);
      // Plain words: no status code, no variable name, no vendor.
      expect(sentence, kind).not.toMatch(/\b\d{3}\b|OPENROUTER|_ENV|process\.env/i);
    }
    // And the composer renders exactly those two and nothing for a reachable model.
    const composer = readFileSync(COMPOSER, "utf8");
    expect(composer).toContain("modelReachKind === \"model\" ? null");
    expect(composer).toContain("familyTexts.answeredByKeyword");
    expect(composer).toContain("familyTexts.assistantUnavailable");
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
    const composer = readFileSync(COMPOSER, "utf8");
    // The prop is a kind, not a reach: there is no `.reason` on it to render by accident.
    expect(composer).toContain('modelReachKind: "model" | "keyword" | "unavailable"');
    expect(composer).not.toMatch(/reach\.reason|modelReach\(/);
  });
});
