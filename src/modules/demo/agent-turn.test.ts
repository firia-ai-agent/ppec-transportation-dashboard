import { describe, expect, it } from "vitest";
import { demoDay } from "@/domain/board/day";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "@/modules/agent/config";
import type { LlmProvider, ProviderCall, ProviderResponseBody } from "@/modules/agent/providers/provider";
import { toolCall } from "@/modules/agent/providers/fake";
import { findLeaks } from "@/modules/agent/redact";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { childByKey } from "./fixtures/standard";
import {
  approveDropoff,
  demoAgentTurn,
  dropoffRequestIn,
  requestedTime,
} from "./agent-turn";

/**
 * The agent turn a founder drives from the phone panel (PRD §18.2 steps 9–10, AT-01, AT-09).
 *
 * Every piece under test is the production one — the §11.1 prompt, the gateway, the §11.2 policy
 * engine — so what these assert is the *wiring* and the two §11.2 rules the demo turns on: a
 * human-tier call proposes and never mutates, and the confirmation that follows an approval is an
 * allow-listed template rather than words a model wrote.
 */

const day = demoDay();
const ASK = "Can Noah be dropped at grandma's at 5?";

/** The deployment that has confirmed demo-data operation but holds no key: the degraded path. */
const NO_KEY = { [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE, [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS };

/**
 * A scripted model, with the prompt it was handed kept for inspection: the prompt is half of what
 * this suite is about (TEST-SEC-01), and the shipped fake keeps only its hash.
 */
type ScriptedProvider = LlmProvider & { readonly prompts: string[] };

function scripted(body: ProviderResponseBody): ScriptedProvider {
  const config = loadAgentConfig({});
  const prompts: string[] = [];
  return {
    kind: "fake",
    vendor: config.provider,
    endpoint: config.endpointAllowList[0],
    prompts,
    async invoke(call: ProviderCall) {
      prompts.push(call.prompt);
      return body;
    },
  };
}

/** The §11.2 answer to a custody request: a proposal, never an edit. */
const proposes = () =>
  scripted(
    toolCall("propose_contact_or_profile_change", {
      family_token: "F2",
      category: "CUSTODY",
      claim_summary: "asks for the afternoon drop-off at a relative's at 5",
      source_message_id: "M-F2-1",
    }),
  );

describe("what the text asks for, read without a model", () => {
  it("reads the hour a parent writes, and means the afternoon", () => {
    expect(requestedTime("Can Noah be dropped at grandma's at 5?")).toBe("17:00");
    expect(requestedTime("drop off at 5pm please")).toBe("17:00");
    expect(requestedTime("can he be dropped at 17:15")).toBe("17:15");
    expect(requestedTime("dropped at 9am instead")).toBe("09:00");
  });

  it("asks for no particular time when the text names none", () => {
    expect(requestedTime("can he be dropped at grandma's")).toBeNull();
    expect(dropoffRequestIn("C2", "the van has not arrived", day)).toBeNull();
  });

  it("knows which ride the request is about, and the window the family holds now", () => {
    const request = dropoffRequestIn("C2", ASK, day);
    expect(request).toMatchObject({ childKey: "C2", requestedHhmm: "17:00" });
    expect(request?.plannedWindowText).toMatch(/PM$/);
  });
});

describe("a model turn, judged by §11.2", () => {
  it("proposes rather than changes anything, and the proposal is bound to that exact call", async () => {
    const turn = await demoAgentTurn({ childKey: "C2", text: ASK, day, env: NO_KEY, provider: proposes() });

    expect(turn.source).toBe("model");
    expect(turn.tool).toBe("propose_contact_or_profile_change");
    expect(turn.verdict).toBe("PROPOSAL");
    expect(turn.rule).toBe("human_tier_requires_approval");
    expect(turn.mutated).toBe(false);
    expect(turn.approvalKey).toHaveLength(64);
    expect(turn.dropoff).toMatchObject({ childKey: "C2", requestedHhmm: "17:00" });
  });

  it("sends the model a prompt with no name and no number in it (TEST-SEC-01)", async () => {
    const provider = proposes();
    await demoAgentTurn({ childKey: "C2", text: ASK, day, env: NO_KEY, provider });
    const prompt = provider.prompts[0];
    expect(findLeaks(prompt)).toEqual([]);
    expect(prompt).not.toContain(childByKey("C2").firstName);
    // …and the child is still identifiable, by the token the tool catalog takes.
    expect(prompt).toContain("C2");
  });

  it("blocks a call that names another family, however the model phrases it", async () => {
    const other = scripted(
      toolCall("propose_contact_or_profile_change", {
        family_token: "F7",
        category: "CUSTODY",
        claim_summary: "asks about another family's child",
        source_message_id: "M-F2-1",
      }),
    );
    const turn = await demoAgentTurn({ childKey: "C2", text: ASK, day, env: NO_KEY, provider: other });
    expect(turn.verdict).toBe("BLOCK");
    expect(turn.mutated).toBe(false);
  });
});

describe("the degraded path, labelled", () => {
  it("falls back to the keyword parser with no key, and says which deployment setting is missing", async () => {
    const turn = await demoAgentTurn({ childKey: "C2", text: ASK, day, env: NO_KEY });

    expect(turn.source).toBe("keyword");
    expect(turn.model).toBeNull();
    expect(turn.degradedReason).toContain("OPENROUTER_API_KEY");
    // The fallback escalates and nothing else: it never guesses an action (providers/keyword.ts).
    expect(turn.tool).toBe("escalate_exception");
    expect(turn.verdict).toBe("ALLOW");
  });

  it("names the variable and never a value", async () => {
    const turn = await demoAgentTurn({
      childKey: "C2",
      text: ASK,
      day,
      env: { ...NO_KEY, OPENROUTER_API_KEY: "" },
    });
    expect(turn.degradedReason).not.toContain("sk-");
  });
});

describe("approving the proposal", () => {
  const request = dropoffRequestIn("C2", ASK, day)!;
  const approved = approveDropoff(request, day);

  it("moves the drop-off the family holds, and says both windows", () => {
    expect(approved.beforeWindowText).toMatch(/4:\d\d/);
    expect(approved.afterWindowText).toBe("5:00–5:10 PM");
    expect(approved.place).toBe("Okeeheelee Park");
    expect(approved.vanLabel).toBe("V2 center van");
  });

  it("confirms it with an allow-listed template, not with words a model wrote", () => {
    expect(approved.reply.templateId).toBe("dropoff.changed");
    expect(approved.reply.body).toContain("New drop-off 5:00–5:10 PM at Okeeheelee Park");
    expect(approved.reply.body).toContain("[DEMO]");
    // Every var is a code, a date or a clock time — the outbox's own rule (Veri #12).
    for (const value of Object.values(approved.reply.vars)) expect(value).toMatch(/^[A-Z0-9:-]+$/);
    // And no child's name reaches the family's phone.
    expect(approved.reply.body).not.toContain(approved.childFirstName);
  });
});
