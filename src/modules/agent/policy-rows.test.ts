/**
 * VERI-1 (part 1 of 2): the policy table against the tool registry.
 *
 * The §11.2 tool catalog is the agent's whole reach, and `POLICY_ROWS` is what the policy engine
 * knows about each tool: which arguments name a scoped object, and which argument consent is
 * checked on when the tool sends. A tool with no row has been authorized by nobody, so the only
 * safe outcome is a denial — which is the half of VERI-1 that lives in `policy-rows-failshut.test.ts`.
 *
 * This file is the walk, in the spirit of src/auth/access.test.ts: every assertion starts from
 * `TOOL_NAMES` rather than from a list written out here, so the sixteenth tool fails this file
 * until someone has made a deliberate decision about its scope and its consent subject.
 */
import { describe, expect, it } from "vitest";
import { TOOL_COUNT, TOOL_NAMES, TOOL_REGISTRY, type ToolEffect, forbiddenArgReason } from "./tools";
import {
  POLICY_ROWS,
  type PolicyContext,
  evaluate,
  familyScope,
  policyRow,
  prohibitedActionRule,
} from "./policy";

const ctx = (): PolicyContext => ({
  scope: familyScope("F1", ["C1", "L-C1-AM", "TH-F1", "ACK-1", "TK-1", "MSG-1", "SESS-C1"], ["V1", "P1", "R1"]),
  sendableSubjects: new Set(["C1", "TH-F1", "SESS-C1", "P1"]),
  sourceMessageId: "MSG-1",
});

/** The declared argument names of a tool, from its zod schema rather than from a second list. */
function schemaArgs(tool: string): string[] {
  return Object.keys(TOOL_REGISTRY[tool].schema.shape);
}

describe("VERI-1: every registry tool has a policy row", () => {
  it("VERI-1 the walk itself works: all 15 catalog tools, and the table has exactly those keys", () => {
    expect(TOOL_NAMES).toHaveLength(TOOL_COUNT);
    expect(Object.keys(POLICY_ROWS).sort()).toEqual([...TOOL_NAMES].sort());
    // No row for a tool that does not exist: a stale row is a rule nothing enforces.
    for (const tool of Object.keys(POLICY_ROWS)) expect(TOOL_NAMES, tool).toContain(tool);
  });

  it.each(TOOL_NAMES.map((n) => [n] as const))("VERI-1 %s has a complete, well-formed row", (tool) => {
    const row = policyRow(tool);
    expect(row, `${tool} has no policy row`).not.toBeNull();
    expect(row!.tool).toBe(tool);
    expect(row!.note.length).toBeGreaterThan(0);

    // Every scoped argument is a real argument of this tool's schema. A typo here would be worse
    // than a missing row: the post-validator would check a field the model never sends and pass.
    const args = schemaArgs(tool);
    for (const field of row!.scopedArgs) {
      expect(args, `${tool}.${field} is not an argument of this tool`).toContain(field);
    }
    expect(new Set(row!.scopedArgs).size).toBe(row!.scopedArgs.length);
  });

  /*
   * The consent subject is declared by every tool whose call CARRIES outbound copy — not only by
   * the ones that send it (S1-7).
   *
   * `send_followup` and `request_clarification` propose their message now, and the consent check
   * reads the same row for them as before (policy.ts step 9): a card offering to text a family
   * that has withdrawn consent is a card nobody should be shown, so the refusal stays where
   * every other one is, before a row exists. Dropping their `sendSubject` with the tier change
   * would have moved that check to drain and shown somebody the words first.
   */
  it.each(TOOL_NAMES.map((n) => [n, TOOL_REGISTRY[n].effect] as const))(
    "VERI-1 %s (%s) declares a consent subject exactly when it carries outbound copy",
    (tool, effect: ToolEffect) => {
      const row = policyRow(tool)!;
      if (effect === "send" || TOOL_REGISTRY[tool].sendCopy !== null) {
        expect(row.sendSubject, `${tool} carries copy with no consent subject`).not.toBeNull();
        expect(schemaArgs(tool)).toContain(row.sendSubject!);
      } else {
        expect(row.sendSubject, `${tool} carries no copy but names a consent subject`).toBeNull();
      }
    },
  );

  it("VERI-1 the four outbound tools are the ones §11.2 marks as outbound", () => {
    const outbound = TOOL_NAMES.filter((n) => TOOL_REGISTRY[n].effect === "send" || TOOL_REGISTRY[n].sendCopy !== null);
    expect(outbound).toEqual([
      "request_clarification",
      "send_followup",
      "notify_affected_therapist",
      "request_provider_capability",
    ]);
    // The same four §11.2 marks outbound. Two of them propose their message and two send it
    // (S1-7); all four are consent-checked by the row, which is what this is about.
    expect(outbound.every((n) => policyRow(n)!.sendSubject !== null)).toBe(true);
    expect(TOOL_NAMES.filter((n) => TOOL_REGISTRY[n].effect === "send")).toEqual([
      "notify_affected_therapist",
      "request_provider_capability",
    ]);
  });

  it("VERI-1 no row names an argument the catalog may not even have (recipient/permission/site)", () => {
    for (const row of Object.values(POLICY_ROWS)) {
      for (const field of [...row.scopedArgs, ...(row.sendSubject ? [row.sendSubject] : [])]) {
        expect(forbiddenArgReason(field), `${row.tool}.${field}`).toBeNull();
      }
    }
  });
});

describe("VERI-1: a tool with no row is denied", () => {
  it.each([
    // Not in the catalog, so not in the table either: the two lists cannot disagree about these.
    "rogue_send_tool",
    "wibble",
    "get_leg_state_v2",
    "SEND_FOLLOWUP",
  ])("VERI-1 unregistered tool %s is blocked and never evaluated as if it had a row", (tool) => {
    expect(policyRow(tool)).toBeNull();
    expect(TOOL_NAMES).not.toContain(tool);
    const d = evaluate({ tool, args: { child_token: "C1", body: "pickup is at 8:15" } }, ctx());
    expect(d.verdict).toBe("BLOCK");
    // Named as the prohibition it attempts when the name says which one, else schema_only_tools.
    expect(d.verdict === "BLOCK" && d.rule).toBe(prohibitedActionRule(tool) ?? "schema_only_tools");
    expect(d.verdict === "BLOCK" && d.tasks[0].type).toBe("staff_review");
  });
});
