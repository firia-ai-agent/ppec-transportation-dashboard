import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API, ENDPOINTS } from "@/auth/access";
import { ACTION_LIST, SERVER_ACTION_EXPORTS } from "./registry";
import { ACTION_TOOLS, TOOL_FOR_ACTION } from "@/modules/agent/action-tools";
import { TOOL_NAMES } from "@/modules/agent/tools";

/**
 * PARITY (ledger #74, S5): every write a person can make from a screen is one entry in the action
 * registry, and the screen reaches it through that entry — so the agent, whose action tools are
 * generated from the same registry, can do exactly what a person can, through the same function.
 *
 * A new screen write with no entry fails here. So does a route that goes around the registry to
 * the domain function directly: that would be a second path the agent does not share.
 */
const REPO = process.cwd();
const read = (file: string) => readFileSync(path.join(REPO, file), "utf8");

/**
 * Session writes that are not actions a person takes on the day, each with its reason. Kept short
 * on purpose: an entry here is a screen write the agent cannot make.
 */
const NOT_AN_ACTION: Readonly<Record<string, string>> = {
  [API.agentAsk]: "the ask itself: what a person types to the agent, not a change to the day",
  "action:staff-action-confirm": "the press on a confirm card: it runs a registry action, it is not one",
};

/** The writes a signed-in person can make: POST routes and server actions behind a session. */
const SESSION_WRITES = ENDPOINTS.filter((e) => e.auth.kind === "session" && e.methods.includes("POST"));

describe("every screen write is one registry action (S5)", () => {
  it("has an entry for every session write in the access table", () => {
    const covered = new Set(ACTION_LIST.map((a) => a.endpoint));
    const missing = SESSION_WRITES.map((e) => e.path).filter((p) => !(p in NOT_AN_ACTION) && !covered.has(p));
    expect(missing, "a screen write with no action-registry entry: the agent cannot make it").toEqual([]);
  });

  it("maps every exported server action to an entry, by name", () => {
    for (const row of SESSION_WRITES.filter((e) => e.kind === "action" && !(e.path in NOT_AN_ACTION))) {
      const exported = [...read(row.file).matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
      expect(exported.length, row.file).toBeGreaterThan(0);
      for (const name of exported) expect(SERVER_ACTION_EXPORTS[name], `${row.file} ${name}`).toBeDefined();
    }
  });

  it("names a real access row for every entry, and no entry twice", () => {
    const paths = new Set(ENDPOINTS.map((e) => e.path));
    for (const a of ACTION_LIST) expect(paths.has(a.endpoint), a.name).toBe(true);
    expect(new Set(ACTION_LIST.map((a) => a.name)).size).toBe(ACTION_LIST.length);
  });
});

describe("every registry action is an agent tool (S5, the agent's half)", () => {
  it("names an agent tool for every action, and that tool runs that action", () => {
    for (const a of ACTION_LIST) {
      const name = TOOL_FOR_ACTION[a.name];
      expect(name, `${a.name} has no agent tool: the agent cannot do what a person can`).toBeDefined();
      expect(TOOL_NAMES).toContain(name);
    }
  });

  it("makes exactly the actions a person must press human-tier (a confirm card), and the rest the agent's own", () => {
    for (const t of ACTION_TOOLS) {
      const action = ACTION_LIST.find((a) => a.name === t.action)!;
      expect(t.tier, t.name).toBe(action.confirm ? "human" : "auto");
    }
  });
});

describe("the screen goes through the registry, not around it (S6)", () => {
  it("has every write route run its registry entry and call no domain writer of its own", () => {
    for (const row of SESSION_WRITES.filter((e) => e.kind === "route" && !(e.path in NOT_AN_ACTION))) {
      const source = read(row.file);
      expect(source, row.file).toMatch(/ACTIONS\.\w+\.run\(screenCtx\(/);
      expect(source, row.file).not.toMatch(/\b(savePlanRequest|placeChildRequest|setChildNeedsRequest|putVanSetupRequest|handleDemoReset|decideApproval|openAlert)\(/);
    }
  });

  it("has every server action run its registry entry", () => {
    const source = read("src/app/(app)/family-texts/actions.ts");
    for (const name of Object.values(SERVER_ACTION_EXPORTS)) {
      expect(source).toMatch(new RegExp(`ACTIONS\\.${name}\\.run\\(screenCtx\\(`));
    }
  });
});
