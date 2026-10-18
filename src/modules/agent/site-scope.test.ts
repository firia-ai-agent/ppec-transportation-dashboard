/**
 * VERI-3: no tool can reach another site's data.
 *
 * A run belongs to one site and one family (`FamilyScope`), and the scope is built from the
 * session that started the run — the model never names a site, because no tool schema has an
 * argument it could name one in (asserted below, and in tools.test.ts). That leaves exactly one
 * way for another tenant's object to enter: an id in an argument. This file walks every scoped
 * argument of every tool in `POLICY_ROWS` and puts another site's id in it.
 *
 * The bar is a 404, not a 403. A cross-site id, another family's id, and an id that exists nowhere
 * at all must be refused *in the same words*, so that a hijacked run cannot use the difference
 * between "no such leg" and "a leg you may not see" as an existence oracle over the other tenants
 * in the database. The audit still knows which it was — that is what the rule on the decision is
 * for — but the refusal itself says nothing, and does not echo the id back.
 */
import { describe, expect, it } from "vitest";
import { TOOL_NAMES, TOOL_REGISTRY, forbiddenArgReason, jsonSchemaPropertyNames, toolJsonSchema } from "./tools";
import { POLICY_ROWS, type PolicyContext, evaluate, familyScope, validateFamilyScope } from "./policy";

/* This run: site S1, family F1. V1/V2/P1/R1 are S1's fleet, providers and routes. */
const SCOPE = familyScope(
  "F1",
  ["C1", "L-C1-AM", "L-C1-PM", "TH-F1", "ACK-1", "TK-1", "MSG-1", "SESS-C1"],
  ["V1", "V2", "P1", "R1"],
  "S1",
);

/** Site S2's world: every id below is a real object — in a tenant this run may not see. */
const OTHER_SITE = new Set([
  "S2", "F-S2", "C-S2", "L-S2-AM", "TH-S2", "SESS-S2", "ACK-S2", "TK-S2", "MSG-S2", "V-S2", "P-S2", "R-S2",
]);

/** Another family, same site. Here only to show its refusal reads identically. */
const OTHER_FAMILY = new Set(["F2", "C2", "L-C2-AM", "TH-F2"]);

const ctx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: SCOPE,
  sendableSubjects: new Set(["C1", "TH-F1", "SESS-C1", "P1"]),
  foreignTokens: OTHER_FAMILY,
  foreignSiteTokens: OTHER_SITE,
  sourceMessageId: "MSG-1",
  ...overrides,
});

/** One schema-valid, in-scope, consented call per tool. The walk mutates one argument at a time. */
const VALID_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  resolve_sender: { message_id: "MSG-1" },
  get_leg_state: { leg_id: "L-C1-AM" },
  cancel_attendance_or_leg: {
    child_token: "C1",
    date: "2026-10-16",
    day_part: "AM",
    reason_code: "ILLNESS",
    expected_self_arrival: null,
    expected_version: 3,
  },
  request_clarification: {
    thread_id: "TH-F1",
    ambiguity_type: "WHICH_CHILD",
    candidate_tokens: ["C1"],
    draft_template_id: "generic.notice",
  },
  record_acknowledgment: { ack_id: "ACK-1", status: "CONFIRMED", source_message_id: "MSG-1" },
  send_followup: {
    audience: "GUARDIAN_OF_CHILD",
    subject_token: "C1",
    template_id: "leg.canceled",
    vars: { legDate: "2026-10-16", reasonCode: "FAMILY_REQUEST" },
  },
  notify_affected_therapist: { therapy_session_token: "SESS-C1", child_token: "C1", impact: "ABSENT", eta: null },
  request_provider_capability: {
    vehicle_token: "V1",
    provider_token: "P1",
    route_token: "R1",
    required: ["LIFT_OR_RAMP"],
  },
  record_capability_report: {
    vehicle_token: "V1",
    parsed: { layout_code: "L1WC3A", wc_positions: 1, amb_positions: 3, lift_present: true },
    source_message_id: "MSG-1",
    state: "REPORTED",
    confidence: 0.9,
  },
  report_boarding: { leg_id: "L-C1-AM", source: "GUARDIAN_REPLY", state: "BOARDED_REPORTED", expected_version: 3 },
  propose_dropoff_change: {
    child_token: "C1",
    leg_id: "L-C1-PM",
    requested_dropoff_time: "17:00",
    plan_version_basis: 3,
    rationale_code: "FAMILY_REQUEST",
  },
  propose_manifest_reallocation: {
    infeasible_vehicle_token: "V1",
    leg_ids: ["L-C1-AM"],
    options: [{ vehicle_token: "V2", leg_ids: ["L-C1-AM"], added_minutes: 6 }],
    rationale_code: "CAPACITY",
  },
  propose_contact_or_profile_change: {
    family_token: "F1",
    category: "EQUIPMENT",
    claim_summary: "guardian says the booster is no longer needed",
    source_message_id: "MSG-1",
  },
  escalate_exception: {
    severity: "AMBER",
    category: "POLICY_BLOCK",
    leg_id: "L-C1-AM",
    summary: "guardian asked about the morning van",
    next_step_code: "STAFF_REVIEW",
  },
  close_task: { task_id: "TK-1", evidence_ref: "MSG-1" },
  summarize_thread_for_staff: { thread_id: "TH-F1", summary: "guardian canceled the morning leg" },
};

/**
 * What another site's value for this argument looks like — the same *shape* as the legitimate one,
 * so the only thing wrong with the call is whose object it names. `retag` turns the S2 id into an
 * id of no site at all, which is how the "exists nowhere" case stays shape-identical too.
 */
const FOREIGN_VALUES: Readonly<Record<string, unknown>> = {
  message_id: "MSG-S2",
  source_message_id: "MSG-S2",
  leg_id: "L-S2-AM",
  leg_ids: ["L-S2-AM"],
  child_token: "C-S2",
  subject_token: "C-S2",
  candidate_tokens: ["C-S2"],
  thread_id: "TH-S2",
  ack_id: "ACK-S2",
  therapy_session_token: "SESS-S2",
  vehicle_token: "V-S2",
  infeasible_vehicle_token: "V-S2",
  provider_token: "P-S2",
  route_token: "R-S2",
  family_token: "F-S2",
  task_id: "TK-S2",
  evidence_ref: "MSG-S2",
  options: [{ vehicle_token: "V-S2", leg_ids: ["L-S2-AM"], added_minutes: 6 }],
};

const retag = (value: unknown, tag: string): unknown =>
  JSON.parse(JSON.stringify(value).replaceAll("S2", tag)) as unknown;

/** Every (tool, scoped argument) pair in the table. The walk, not a list written out here. */
const SCOPED_PAIRS = Object.values(POLICY_ROWS).flatMap((row) =>
  row.scopedArgs.map((field) => [row.tool, field] as const),
);

const blockOf = (tool: string, args: Record<string, unknown>, context = ctx()) => {
  const d = evaluate({ tool, args }, context);
  expect(d.verdict, `${tool} ${JSON.stringify(args)}`).toBe("BLOCK");
  return d as Extract<typeof d, { verdict: "BLOCK" }>;
};

describe("VERI-3: the walk covers the catalog", () => {
  it("VERI-3 has a schema-valid call for all 16 tools, and a foreign value for every scoped argument", () => {
    expect(Object.keys(VALID_ARGS).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of TOOL_NAMES) {
      expect(TOOL_REGISTRY[tool].schema.safeParse(VALID_ARGS[tool]).success, tool).toBe(true);
    }
    expect(SCOPED_PAIRS.length).toBeGreaterThanOrEqual(20);
    for (const [tool, field] of SCOPED_PAIRS) {
      expect(FOREIGN_VALUES[field], `${tool}.${field} has no cross-site value to test with`).toBeDefined();
    }
  });

  it("VERI-3 an in-scope call is not blocked, so the refusals below mean something", () => {
    for (const tool of TOOL_NAMES) {
      const d = evaluate({ tool, args: VALID_ARGS[tool] }, ctx());
      expect(d.verdict, tool).not.toBe("BLOCK");
    }
  });

  it("VERI-3 no tool schema has an argument that could name a site or a tenant, at any depth", () => {
    for (const tool of TOOL_NAMES) {
      for (const prop of jsonSchemaPropertyNames(toolJsonSchema(tool))) {
        expect(/^(?:site|tenant|org)/i.test(prop), `${tool}.${prop}`).toBe(false);
        expect(forbiddenArgReason(prop), `${tool}.${prop}`).toBeNull();
      }
    }
    // The site is the scope's, handed in by the caller — never a value the model chose.
    expect(SCOPE.siteToken).toBe("S1");
  });
});

describe("VERI-3: another site's id in a scoped argument is refused", () => {
  it.each(SCOPED_PAIRS.map(([tool, field]) => [`${tool}.${field}`, tool, field] as const))(
    "VERI-3 %s rejects an id belonging to site S2",
    (_name, tool, field) => {
      const args = { ...VALID_ARGS[tool], [field]: FOREIGN_VALUES[field] };
      const d = blockOf(tool, args);
      expect(d.rule).toBe("cross_site_disclosure");
      expect(d.reason).toBe(`argument ${pathOf(field, FOREIGN_VALUES[field])} references an object outside this run's scope`);
      // The refusal does not echo the other tenant's id back, nor name its site.
      expect(JSON.stringify(d)).not.toContain("S2");
      expect(d.tasks[0]).toMatchObject({ type: "staff_review", rule: "cross_site_disclosure", familyToken: "F1" });
    },
  );

  it.each(SCOPED_PAIRS.map(([tool, field]) => [`${tool}.${field}`, tool, field] as const))(
    "VERI-3 %s refuses S2's id in the same words as an id that exists nowhere (404, not 403)",
    (_name, tool, field) => {
      const crossSite = blockOf(tool, { ...VALID_ARGS[tool], [field]: FOREIGN_VALUES[field] });
      const nowhere = blockOf(tool, { ...VALID_ARGS[tool], [field]: retag(FOREIGN_VALUES[field], "ZZ") });
      expect(nowhere.reason).toBe(crossSite.reason);
      // Same words, different rule: the audit can still tell a tenant breach from a typo.
      expect(nowhere.rule).toBe("cross_family_disclosure");
      expect(crossSite.rule).toBe("cross_site_disclosure");
    },
  );

  it("VERI-3 another family's id in the same site reads identically too", () => {
    const crossFamily = blockOf("send_followup", { ...VALID_ARGS.send_followup, subject_token: "C2" });
    const crossSite = blockOf("send_followup", { ...VALID_ARGS.send_followup, subject_token: "C-S2" });
    expect(crossFamily.reason).toBe(crossSite.reason);
    expect(crossFamily.rule).toBe("cross_family_disclosure");
  });
});

describe("VERI-3: the tenant boundary holds where ids are not declared objects", () => {
  it.each([
    ["escalate_exception", "summary"],
    ["summarize_thread_for_staff", "summary"],
    ["propose_contact_or_profile_change", "claim_summary"],
  ])("VERI-3 %s.%s refuses another site's id named in prose", (tool, field) => {
    const args = { ...VALID_ARGS[tool], [field]: `the same van also carries L-S2-AM, so both slip` };
    expect(blockOf(tool, args).rule).toBe("cross_site_disclosure");
  });

  it("VERI-3 another site's vehicle, provider or route is out of scope even though they are center-wide", () => {
    for (const field of ["vehicle_token", "provider_token", "route_token"]) {
      const d = blockOf("request_provider_capability", {
        ...VALID_ARGS.request_provider_capability,
        [field]: FOREIGN_VALUES[field],
      });
      expect(d.rule).toBe("cross_site_disclosure");
    }
  });

  it("VERI-3 the nested options of a proposal are walked, not just its top-level ids", () => {
    const d = blockOf("propose_manifest_reallocation", {
      ...VALID_ARGS.propose_manifest_reallocation,
      options: [{ vehicle_token: "V-S2", leg_ids: ["L-S2-AM"], added_minutes: 6 }],
    });
    expect(d.reason).toContain("options[0]");
  });

  it("VERI-3 the post-validator reports what it found, for the audit, without the deny varying", () => {
    expect(
      validateFamilyScope({ tool: "get_leg_state", args: { leg_id: "L-S2-AM" } }, ctx()),
    ).toEqual(
      expect.arrayContaining([{ path: "leg_id", token: "L-S2-AM", foreign: false, crossSite: true }]),
    );
    expect(validateFamilyScope({ tool: "get_leg_state", args: { leg_id: "L-C1-AM" } }, ctx())).toEqual([]);
  });

  it("VERI-3 a run with no knowledge of the other tenant still refuses its ids", () => {
    // `foreignSiteTokens` is classification only. Drop it and the id is simply not in scope —
    // which is the refusal that matters, and the one that does not need an oracle to work.
    const blind = ctx({ foreignSiteTokens: undefined, foreignTokens: undefined });
    const d = blockOf("get_leg_state", { leg_id: "L-S2-AM" }, blind);
    expect(d.rule).toBe("cross_family_disclosure");
    expect(d.reason).toBe("argument leg_id references an object outside this run's scope");
  });
});

/** The dotted path the post-validator reports for a value: `field`, `field[0]`, `field[0].sub`. */
function pathOf(field: string, value: unknown): string {
  if (typeof value === "string") return field;
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") return `${field}[0]`;
    // options[]: the first string leaf of the first option, in key order.
    const key = Object.entries(first as Record<string, unknown>).find(([, v]) => typeof v === "string")![0];
    return `${field}[0].${key}`;
  }
  throw new Error(`no path rule for ${field}`);
}
