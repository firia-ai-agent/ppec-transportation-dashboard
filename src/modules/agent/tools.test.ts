/**
 * The §11.2 tool catalog, and the rule that keeps it safe: "schema-only tools with no
 * recipient/permission args". The walker below is the enforcement — it visits every property of
 * every tool's JSON Schema at every depth, so the next tool anyone adds is checked too.
 */
import { describe, expect, it } from "vitest";
import { TEMPLATE_VARS, disallowedVars } from "@/modules/outbox/outbox";
import {
  AUDIENCES,
  FOLLOWUP_TEMPLATE_FAMILIES,
  FOLLOWUP_TEMPLATE_IDS,
  FORBIDDEN_ARG_TOKENS,
  TOOL_COUNT,
  TOOL_NAMES,
  TOOL_REGISTRY,
  forbiddenArgReason,
  isRenderableTemplate,
  jsonSchemaPropertyNames,
  toolDeclarations,
  toolJsonSchema,
} from "./tools";

describe("§11.2 tool catalog", () => {
  it("has all 29 tools, each with a tier and an effect", () => {
    expect(TOOL_NAMES).toHaveLength(TOOL_COUNT);
    expect(TOOL_NAMES).toEqual([
      "resolve_sender",
      "get_leg_state",
      "read_guardian_thread",
      "cancel_attendance_or_leg",
      "request_clarification",
      "record_acknowledgment",
      "send_followup",
      "notify_affected_therapist",
      "request_provider_capability",
      "record_capability_report",
      "report_boarding",
      "propose_manifest_reallocation",
      "propose_contact_or_profile_change",
      "propose_dropoff_change",
      "escalate_exception",
      "close_task",
      "summarize_thread_for_staff",
      "reply_to_staff",
      // Ledger #77: a teammate's tools — the screens' reads, every change a card, Take (agent/action-tools.ts).
      "get_activity",
      "get_plan",
      "get_child",
      "get_waiting",
      "read_family_texts",
      "propose_plan_change",
      "propose_van_setup",
      "propose_needs_change",
      "propose_card_decision",
      "restart_demo_day",
      "take_alert",
    ]);
    for (const name of TOOL_NAMES) {
      const def = TOOL_REGISTRY[name];
      expect(["auto", "human"]).toContain(def.tier);
      expect(["read", "mutate", "send", "propose"]).toContain(def.effect);
      // Every tool cites where it comes from: the PRD's catalog, or the ruling that added it.
      expect(def.prd, name).toMatch(/§11\.2|ledger #7[4-7]/);
    }
  });

  it("marks the propose_* rows and the two message tools human tier, and they all propose", () => {
    const human = TOOL_NAMES.filter((n) => TOOL_REGISTRY[n].tier === "human");
    /*
     * Five, not three. `request_clarification` and `send_followup` joined the tier on Firia's
     * S1-7 ruling (2026-10-18): a templated message is still a message to a family, so a person
     * decides it. They do not start with `propose_` — the names are §11.2's and the PRD's, and
     * renaming a tool the model is handed is not a thing to do on a Sunday morning — so the
     * naming rule below became a one-way one, with the exception named.
     */
    expect(human).toEqual([
      "request_clarification",
      "send_followup",
      "propose_manifest_reallocation",
      "propose_contact_or_profile_change",
      "propose_dropoff_change",
      // Ledger #77: every change a teammate makes is a card a person approves.
      "propose_plan_change",
      "propose_van_setup",
      "propose_needs_change",
      "propose_card_decision",
      "restart_demo_day",
    ]);
    for (const n of human) expect([n, TOOL_REGISTRY[n].effect]).toEqual([n, "propose"]);
    // Every `propose_*` tool is human tier. The two message tools are the only human-tier tools
    // that are not named that way.
    expect(TOOL_NAMES.filter((n) => n.startsWith("propose_")).every((n) => TOOL_REGISTRY[n].tier === "human")).toBe(true);
  });

  it("says where every tool that carries outbound copy gets it, and nothing else does", () => {
    /*
     * The rule used to be "every SENDING tool declares its copy source, and nothing else does".
     * S1-7 split sending from carrying: `send_followup` and `request_clarification` still name a
     * template and vars that would reach a family, they just propose them now instead of sending
     * them. They keep the declaration, and policy.ts step 6 keeps checking it — a tool that
     * dropped it on the way into the human tier would be a proposal nobody validated.
     */
    const MESSAGE_PROPOSERS = ["send_followup", "request_clarification"];
    for (const name of TOOL_NAMES) {
      const def = TOOL_REGISTRY[name];
      const carries = def.effect === "send" || MESSAGE_PROPOSERS.includes(name);
      if (!carries) {
        expect(def.sendCopy, `${name} carries no outbound copy but declares a source`).toBeNull();
        continue;
      }
      expect(def.sendCopy, `${name} carries copy and says nothing about where it comes from`).not.toBeNull();
      // A `free_text` declaration here would be a tool that writes to a family, which §11.2
      // allows only behind a human approval (policy.ts step 10, free-text-approval.test.ts) —
      // and the catalog has none.
      expect(def.sendCopy!.kind, `${name} declares free-text copy`).not.toBe("free_text");
      // What goes out on the agent's own authority is still auto tier, and is still only the
      // sends: the two proposers are human tier, which is the whole of the S1-7 ruling.
      expect([name, def.tier], name).toEqual([name, MESSAGE_PROPOSERS.includes(name) ? "human" : "auto"]);
    }
  });

  it("points each templated send at real arguments and real outbox templates", () => {
    for (const name of TOOL_NAMES) {
      const def = TOOL_REGISTRY[name];
      if (def.sendCopy?.kind !== "template") continue;
      const args = Object.keys(def.schema.shape);
      // A typo in either name would be worse than no declaration: the policy engine would check a
      // field the model never sends, find no template id, and pass.
      expect(args, `${name}.${def.sendCopy.idArg}`).toContain(def.sendCopy.idArg);
      if (def.sendCopy.varsArg !== null) expect(args, `${name}.${def.sendCopy.varsArg}`).toContain(def.sendCopy.varsArg);
      // Every id the schema will accept is one the outbox can render, so the template allow-list
      // the policy engine re-checks can never be wider than the copy that exists.
      const ids = (toolJsonSchema(name).properties as Record<string, { enum?: string[] }>)[def.sendCopy.idArg]?.enum;
      expect(ids, `${name}.${def.sendCopy.idArg} is not an enum of template ids`).toBeDefined();
      for (const id of ids!) expect(isRenderableTemplate(id), `${name} → ${id}`).toBe(true);
    }
  });

  it("refuses an argument a model invented on a sending tool, rather than stripping it", () => {
    // A stripped argument is a message that goes out anyway with the prose quietly removed; on a
    // tool that sends, the right answer is to refuse the whole call (REJECTED_INVALID_ARGS).
    for (const name of TOOL_NAMES.filter((n) => TOOL_REGISTRY[n].effect === "send")) {
      const schema = TOOL_REGISTRY[name].schema;
      const base = {
        request_clarification: { thread_id: "TH-F1", ambiguity_type: "WHICH_CHILD", candidate_tokens: ["C1"], draft_template_id: "generic.notice" },
        send_followup: { audience: "GUARDIAN_OF_CHILD", subject_token: "C1", template_id: "leg.canceled", vars: { legDate: "2026-10-16", reasonCode: "FAMILY_REQUEST" } },
        notify_affected_therapist: { therapy_session_token: "SESS-C1", child_token: "C1", impact: "ABSENT", eta: null },
        request_provider_capability: { vehicle_token: "V1", provider_token: "P1", route_token: "R1", required: ["LIFT_OR_RAMP"] },
      }[name]!;
      expect(schema.safeParse(base).success, name).toBe(true);
      expect(schema.safeParse({ ...base, body: "running late" }).success, name).toBe(false);
      expect((toolJsonSchema(name) as { additionalProperties?: unknown }).additionalProperties, name).toBe(false);
    }
  });

  it("exposes each tool as JSON Schema (§11.2 JSON-schema tool calls only)", () => {
    // Three tools take nothing: the site and the day are the run's own, never an argument (ledger
    // #74, #77). A card's `note` is its sentence (ledger #75), never an input, so not counted.
    const NO_ARGUMENTS = ["get_waiting", "get_activity", "restart_demo_day"];
    for (const d of toolDeclarations()) {
      expect(d.parameters).toMatchObject({ type: "object" });
      const count = Object.keys((d.parameters as { properties?: object }).properties ?? {}).filter((k) => k !== "note").length;
      if (NO_ARGUMENTS.includes(d.name)) expect(count, d.name).toBe(0);
      else expect(count, d.name).toBeGreaterThan(0);
    }
  });
});

describe("§11.2: no recipient, phone or permission arguments, at any depth", () => {
  it("walks every schema and finds none", () => {
    const offenders: string[] = [];
    for (const name of TOOL_NAMES) {
      for (const prop of jsonSchemaPropertyNames(toolJsonSchema(name))) {
        const reason = forbiddenArgReason(prop);
        if (reason) offenders.push(`${name}.${prop}: ${reason}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually visits nested object, array-item and record properties", () => {
    // propose_manifest_reallocation nests options[].vehicle_token two levels down.
    expect(jsonSchemaPropertyNames(toolJsonSchema("propose_manifest_reallocation"))).toContain("added_minutes");
    expect(jsonSchemaPropertyNames(toolJsonSchema("record_capability_report"))).toContain("lift_present");
  });

  it("would catch a recipient, address or permission argument if one were added", () => {
    for (const bad of [
      "recipient",
      "recipient_type",
      "to",
      "contact_token",
      "guardian_phone",
      "phoneNumber",
      "msisdn",
      "street_address",
      "zip",
      "permission",
      "auth_scope",
      "override_reason",
      "approved_by",
      "role",
    ]) {
      expect(forbiddenArgReason(bad)).not.toBeNull();
    }
  });

  it("does not fire on the argument names the catalog legitimately uses", () => {
    for (const ok of [
      "child_token",
      "subject_token",
      "audience",
      "template_id",
      "vars",
      "day_part",
      "reason_code",
      "expected_version",
      "state",
      "source_message_id",
      "claim_summary",
      "next_step_code",
    ]) {
      expect(forbiddenArgReason(ok)).toBeNull();
    }
  });

  it("names the three forbidden classes from §11.2, plus the tenant rule they imply", () => {
    expect(Object.keys(FORBIDDEN_ARG_TOKENS).sort()).toEqual(["address", "permission", "recipient", "tenant"]);
    // The run's site comes from the session, never from an argument (VERI-3, site-scope.test.ts).
    for (const bad of ["site", "site_token", "siteId", "tenant", "organization_token"]) {
      expect(forbiddenArgReason(bad), bad).not.toBeNull();
    }
  });
});

describe("send_followup template allow-list", () => {
  it("covers the five §11.2 families", () => {
    expect(Object.keys(FOLLOWUP_TEMPLATE_FAMILIES).sort()).toEqual([
      "absence_to_therapist",
      "ack_reminder",
      "capability_req",
      "confirmation",
      "eta_delay",
    ]);
  });

  it("maps every family onto templates the outbox can actually render", () => {
    for (const [family, ids] of Object.entries(FOLLOWUP_TEMPLATE_FAMILIES)) {
      expect(ids.length, family).toBeGreaterThan(0);
      for (const id of ids) {
        expect(isRenderableTemplate(id), `${family} → ${id}`).toBe(true);
        expect(Object.hasOwn(TEMPLATE_VARS, id)).toBe(true);
      }
    }
    expect(FOLLOWUP_TEMPLATE_IDS.every((id) => isRenderableTemplate(id))).toBe(true);
  });

  it("leaves the var rules to the outbox rather than restating them", () => {
    // A name-bearing var is off every outbox list, so it is off this tool's list too.
    expect(disallowedVars("leg.canceled", { childFirstName: "Mia" })).toContain("childFirstName");
    expect(disallowedVars("leg.canceled", { legDate: "2026-10-16", reasonCode: "FAMILY_REQUEST" })).toEqual([]);
  });

  it("addresses a message by audience role, never by contact", () => {
    expect(AUDIENCES).toContain("GUARDIAN_OF_CHILD");
    expect(AUDIENCES.every((a) => forbiddenArgReason(a) === null || /^STAFF$/.test(a))).toBe(true);
  });
});

describe("schemas reject what §11.2 prohibits expressing", () => {
  it("report_boarding accepts BOARDED_REPORTED only", () => {
    const schema = TOOL_REGISTRY.report_boarding.schema;
    const base = { leg_id: "L-C1-AM", source: "GUARDIAN_REPLY", expected_version: 1 };
    expect(schema.safeParse({ ...base, state: "BOARDED_REPORTED" }).success).toBe(true);
    expect(schema.safeParse({ ...base, state: "BOARDED_VERIFIED" }).success).toBe(false);
  });

  it("record_capability_report accepts REPORTED only", () => {
    const schema = TOOL_REGISTRY.record_capability_report.schema;
    const base = {
      vehicle_token: "V1",
      parsed: { layout_code: "L1WC3A", wc_positions: 1, amb_positions: 3, lift_present: true },
      source_message_id: "MSG-1",
      confidence: 0.8,
    };
    expect(schema.safeParse({ ...base, state: "REPORTED" }).success).toBe(true);
    expect(schema.safeParse({ ...base, state: "VERIFIED" }).success).toBe(false);
  });

  it("refuses a phone number, an address or a sentence where a token belongs", () => {
    const schema = TOOL_REGISTRY.get_leg_state.schema;
    expect(schema.safeParse({ leg_id: "L-C1-AM" }).success).toBe(true);
    for (const bad of ["+1-561-555-0101", "2216 Jog Rd", "the morning leg please", ""]) {
      expect(schema.safeParse({ leg_id: bad }).success, bad).toBe(false);
    }
  });

  it("strips any extra argument a model invents", () => {
    const parsed = TOOL_REGISTRY.get_leg_state.schema.parse({ leg_id: "L-C1-AM", to: "+15615550101", body: "hi" });
    expect(parsed).toEqual({ leg_id: "L-C1-AM" });
  });
});

describe("a teammate's catalog (ledger #77)", () => {
  it("offers a person's run a short list of described tools, with no id, version or date to get wrong", async () => {
    const { STAFF_ASK_TOOLS, ALERT_TOOLS } = await import("./run/staff-ask-context");
    expect(STAFF_ASK_TOOLS.length).toBeLessThanOrEqual(12);
    for (const name of new Set([...STAFF_ASK_TOOLS, ...ALERT_TOOLS])) {
      expect(TOOL_REGISTRY[name].description, name).toBeTruthy();
      const props = jsonSchemaPropertyNames(toolJsonSchema(name));
      expect(props.filter((p) => p === "date" || p === "version" || p.endsWith("_id") || p.endsWith("_version")), name).toEqual([]);
    }
    // Every change is a card a person approves; the one thing it does itself is Take.
    const acts = STAFF_ASK_TOOLS.filter((n) => TOOL_REGISTRY[n].effect === "mutate" || TOOL_REGISTRY[n].effect === "send");
    expect(acts).toEqual(["take_alert"]);
  });
});
