import { describe, expect, it } from "vitest";
import { demoDay } from "@/domain/board/day";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "@/modules/agent/config";
import { SEND_FOOTER } from "@/modules/messaging/templates";
import type { LlmProvider, ProviderCall, ProviderResponseBody } from "@/modules/agent/providers/provider";
import { toolCall } from "@/modules/agent/providers/fake";
import { findLeaks } from "@/modules/agent/redact";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { childByKey } from "./fixtures/standard";
import {
  approveDropoff,
  demoAgentTurn,
  dropoffFromCall,
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
/**
 * The reply the model writes to the parent (Firia, 2026-10-18 11:04 AM ET): warm, short, and an
 * answer to what she actually asked — the five o'clock she named, in the names she uses. It is a
 * tool argument, so a reply of the wrong shape is refused at the gateway like any other.
 */
const MODEL_REPLY = "Hi Dara, yes, we'll drop Noah off at 5 today. Thanks for letting us know!";

/** The deployment that has confirmed demo-data operation but holds no key: no model can answer. */
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

/**
 * The model proposing a drop-off, which is the **only** way a requested time gets in: a field of
 * a schema-validated tool call. The text beside it is the parent's and is never read for one.
 */
const proposesDropoff = () =>
  scripted(
    toolCall("propose_dropoff_change", {
      leg_id: "L-C2-PM",
      requested_dropoff_time: "17:00",
      requested_stop_token: null,
      rationale_code: "PARENT_REQUEST",
      /*
       * The line the coordinator reads beside the thread, required since the 11:15 AM ET ruling.
       * Tokens, not names: every prompt this app sends is token-only, so the model writes "F2"
       * and `identity/names.detokenizeNames` turns it back before the row reaches a screen.
       */
      alert_text: "F2 asked to move the afternoon drop-off to five o'clock.",
      /*
       * The reply the model writes to the parent, required since Firia's 11:04 AM ET ruling: the
       * card is the model's own sentence, which is what answers the question the parent asked.
       */
      reply: MODEL_REPLY,
      source_message_id: "M-F2-1",
      expected_version: 1,
    }),
  );

describe("what the request is, and where it can come from", () => {
  /**
   * The founder's rule of 2026-10-17, from this module's side: there is no reader of the parent's
   * sentence here at all. A drop-off comes off the model's own `propose_dropoff_change`
   * arguments, so a text naming a time that the model did not turn into a call asks for nothing
   * this screen will act on. (The structural half of the rule is
   * `agent/no-keyword-fallback.test.ts`, which fails if a time regex reappears anywhere.)
   */
  it("reads the drop-off off the model's arguments, not out of the family's words", () => {
    const fromCall = dropoffFromCall(
      "C2",
      "propose_dropoff_change",
      { requested_dropoff_time: "17:00", requested_stop_token: null },
      day,
    );
    expect(fromCall).toMatchObject({ childKey: "C2", requestedHhmm: "17:00", requestedStopToken: null });
    expect(fromCall?.plannedWindowText).toMatch(/PM$/);

    // The same sentence, with no tool call behind it, asks for nothing.
    expect(dropoffFromCall("C2", "", {}, day)).toBeNull();
    expect(dropoffFromCall("C2", "escalate_exception", { summary: ASK }, day)).toBeNull();
  });

  it("is nothing at all when the call proposes neither a time nor a place", () => {
    expect(
      dropoffFromCall("C2", "propose_dropoff_change", { requested_dropoff_time: null, requested_stop_token: null }, day),
    ).toBeNull();
  });

  it("takes the place off the call too, as one of the centre's own stops", () => {
    const moved = dropoffFromCall(
      "C2",
      "propose_dropoff_change",
      { requested_dropoff_time: null, requested_stop_token: "PBSC-LW" },
      day,
    );
    expect(moved).toMatchObject({ requestedHhmm: null, requestedStopToken: "PBSC-LW" });
  });
});

describe("a model turn, judged by §11.2", () => {
  it("proposes rather than changes anything, and the proposal is bound to that exact call", async () => {
    const turn = await demoAgentTurn({ childKey: "C2", text: ASK, day, env: NO_KEY, provider: proposes() });

    expect(turn.modelUnavailable).toBe(false);
    expect(turn.tool).toBe("propose_contact_or_profile_change");
    expect(turn.verdict).toBe("PROPOSAL");
    expect(turn.rule).toBe("human_tier_requires_approval");
    expect(turn.mutated).toBe(false);
    expect(turn.approvalKey).toHaveLength(64);
    // A custody claim is not a drop-off: no card, because no call proposed one.
    expect(turn.dropoff).toBeNull();
  });

  it("carries the drop-off only when the model's own call proposed one", async () => {
    const turn = await demoAgentTurn({ childKey: "C2", text: ASK, day, env: NO_KEY, provider: proposesDropoff() });

    expect(turn.tool).toBe("propose_dropoff_change");
    expect(turn.verdict).toBe("PROPOSAL");
    expect(turn.mutated).toBe(false);
    expect(turn.dropoff).toMatchObject({ childKey: "C2", requestedHhmm: "17:00" });
    /*
     * And the reply, in the model's own words, straight off the sanitized arguments — the one
     * prose field in the catalog that is meant for a family, and the reason the card answers the
     * question Dara asked (Firia, 11:04 AM ET). Not redacted: the names in it are the point.
     */
    expect(turn.args.reply).toBe(MODEL_REPLY);
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

describe("no model, no proposal", () => {
  /**
   * The founder's rule of 2026-10-17: *"never compensate with a deterministic text parser if the
   * model isn't available; the owner/staff need to be notified."* There used to be a keyword
   * reader here that escalated; there is nothing now. A deployment with no key produces a turn
   * that says no model answered, proposes no drop-off, and leaves the text for a person.
   */
  it("answers with nothing proposed when no model can be called, and names the missing setting", async () => {
    const turn = await demoAgentTurn({ childKey: "C2", text: ASK, day, env: NO_KEY });

    expect(turn.modelUnavailable).toBe(true);
    expect(turn.model).toBeNull();
    expect(turn.unavailableReason).toContain("OPENROUTER_API_KEY");
    // Nothing was proposed and nothing was chosen: the card the screen would draw does not exist.
    expect(turn.dropoff).toBeNull();
    expect(turn.mutated).toBe(false);
    expect(turn.tool).toBe("");
  });

  it("names the variable and never a value", async () => {
    const turn = await demoAgentTurn({
      childKey: "C2",
      text: ASK,
      day,
      env: { ...NO_KEY, OPENROUTER_API_KEY: "" },
    });
    expect(turn.unavailableReason).not.toContain("sk-");
  });
});

describe("approving the proposal", () => {
  const request = dropoffFromCall(
    "C2",
    "propose_dropoff_change",
    { requested_dropoff_time: "17:00", requested_stop_token: null },
    day,
  )!;
  const approved = approveDropoff(request, day);

  it("moves the drop-off the family holds, and says both windows", () => {
    expect(approved.beforeWindowText).toMatch(/4:\d\d/);
    expect(approved.afterWindowText).toBe("5:00–5:10 PM");
    expect(approved.place).toBe("Okeeheelee Park");
    // "Van 2" since #73: the label a person reads is the van's slot, not "V2 center van" — that
    // put an internal code and a fleet kind on a staff screen.
    expect(approved.vanLabel).toBe("Van 2");
  });

  it("confirms it with an allow-listed template, not with words a model wrote", () => {
    expect(approved.reply.templateId).toBe("dropoff.changed");
    /*
     * Human, and it names the child (Firia, 2026-10-17 10:51 PM ET) — with no clock time in it at
     * all (the COPY RULE in p-rework-approvals5 and Vera's S1-2 checklist item b, both later than
     * the 10:51 PM example that still read "at 3:58 PM"). The *card* still shows the time, because
     * a coordinator is deciding one; the text a family reads says where, not when.
     */
    expect(approved.reply.body).toContain(`Yes — ${approved.childFirstName} gets off at Okeeheelee Park today`);
    expect(approved.reply.body).not.toMatch(/\d{1,2}:\d{2}/);
    // A draft is the message and nothing else: no [DEMO] tag, and no STOP/HELP footer — the
    // send step appends that (Firia, 11:00 PM ET, S1-5; src/modules/messaging/templates.ts).
    expect(approved.reply.body).not.toContain("DEMO");
    expect(approved.reply.body).not.toContain(SEND_FOOTER);
    /*
     * Every var is still a code, a date or a clock time — the outbox's own rule (Veri #12) is
     * untouched by the name in the sentence above. The name is not a var and cannot be one: it is
     * resolved at render time from the child's own row, the way `{stopLabel}` is resolved through
     * a fixed table (src/modules/messaging/templates.ts `RenderFor`). Nothing a model or a
     * coordinator writes can reach a family through either door.
     */
    for (const value of Object.values(approved.reply.vars)) expect(value).toMatch(/^[A-Z0-9:-]+$/);
    expect(Object.keys(approved.reply.vars)).not.toContain("childName");
    expect(JSON.stringify(approved.reply.vars)).not.toContain(approved.childFirstName);
  });
});
