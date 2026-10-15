/**
 * VERI-1 (part 2 of 2): a catalog tool with no policy row FAILS SHUT.
 *
 * With the real catalog this branch is unreachable — `policy-rows.test.ts` proves the two tables
 * agree — so the only way to test the thing we actually care about (what happens on the day
 * someone adds a tool and forgets the row) is to hand the policy engine a catalog it did not
 * expect. `vi.mock` puts two such tools in front of it:
 *
 *  - `rogue_undeclared_tool`, a sending tool the policy table has never heard of;
 *  - `close_task`, whose effect is flipped to `send` — a real tool that grew a new power while
 *    its row still says nothing about consent.
 *
 * Both must be blocked, with the rule naming the missing row rather than a rule about arguments:
 * the exception a human reads has to say "this tool is not declared", not "its leg id looks odd".
 *
 * The mock factory is hoisted above the imports, so the tool name is written out inside it rather
 * than referenced from a const that does not exist yet.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools")>();
  const { z } = await import("zod");
  const rogue = {
    name: "rogue_undeclared_tool",
    tier: "auto" as const,
    effect: "send" as const,
    schema: z.object({ subject_token: z.string(), template_id: z.string() }),
    staffTextFields: [] as const,
    prd: "§11.2: no row — this tool is the regression VERI-1 exists for",
  };
  const closeTaskThatSends = { ...actual.toolDef("close_task")!, effect: "send" as const };
  return {
    ...actual,
    TOOL_REGISTRY: { ...actual.TOOL_REGISTRY, rogue_undeclared_tool: rogue },
    toolDef: (name: string) =>
      name === "rogue_undeclared_tool" ? rogue : name === "close_task" ? closeTaskThatSends : actual.toolDef(name),
  };
});

import { type PolicyContext, evaluate, familyScope, policyRow, validateFamilyScope } from "./policy";
import { toolDef } from "./tools";

const ROGUE = "rogue_undeclared_tool";

const ctx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: familyScope("F1", ["C1", "L-C1-AM", "TH-F1", "TK-1", "MSG-1"], ["V1", "P1", "R1"]),
  sendableSubjects: new Set(["C1", "TH-F1", "P1"]),
  sourceMessageId: "MSG-1",
  ...overrides,
});

describe("VERI-1: a catalog tool the policy table does not declare", () => {
  it("VERI-1 the mock really did put an undeclared tool in the catalog", () => {
    expect(toolDef(ROGUE)).toMatchObject({ effect: "send", tier: "auto" });
    expect(policyRow(ROGUE)).toBeNull();
  });

  it("VERI-1 is blocked with missing_policy_row, and sends nothing", () => {
    const d = evaluate({ tool: ROGUE, args: { subject_token: "C1", template_id: "leg.canceled" } }, ctx());
    expect(d).toMatchObject({ verdict: "BLOCK", rule: "missing_policy_row", tool: ROGUE });
    expect(d.verdict === "BLOCK" && d.tasks[0]).toMatchObject({ type: "staff_review", rule: "missing_policy_row" });
    expect(d.verdict === "BLOCK" && d.reason).toContain(ROGUE);
  });

  it("VERI-1 is blocked even when every argument is in scope and consented", () => {
    // The arguments are impeccable: C1 is this family's child and has live consent. It still
    // fails shut, because "nothing is wrong with the arguments" is not an authorization.
    const d = evaluate({ tool: ROGUE, args: { subject_token: "C1", template_id: "generic.notice" } }, ctx());
    expect(d.verdict).toBe("BLOCK");
  });

  it("VERI-1 the missing row is decided before anything else about the call", () => {
    // Paused, out of scope, and a phone number in an argument: all of them would block too, and
    // none of them is the reason staff need to see. The row check runs first, on purpose.
    const d = evaluate(
      { tool: ROGUE, args: { subject_token: "+1-561-555-0177", template_id: "C2" } },
      ctx({ paused: true }),
    );
    expect(d).toMatchObject({ verdict: "BLOCK", rule: "missing_policy_row" });
  });

  it("VERI-1 the post-validator treats every argument of an undeclared tool as scoped", () => {
    // No row means no declaration of what is family-scoped, so nothing is assumed safe.
    const violations = validateFamilyScope(
      { tool: ROGUE, args: { subject_token: "C1", template_id: "leg.canceled" } },
      ctx(),
    );
    expect(violations.map((v) => v.token)).toContain("leg.canceled");
  });
});

describe("VERI-1: a tool that grows a send without updating its row", () => {
  it("VERI-1 close_task-as-a-sending-tool is blocked for having no consent subject", () => {
    expect(toolDef("close_task")!.effect).toBe("send");
    expect(policyRow("close_task")!.sendSubject).toBeNull();
    const d = evaluate({ tool: "close_task", args: { task_id: "TK-1", evidence_ref: "MSG-1" } }, ctx());
    expect(d).toMatchObject({ verdict: "BLOCK", rule: "missing_policy_row" });
    expect(d.verdict === "BLOCK" && d.reason).toContain("consent subject");
  });
});
