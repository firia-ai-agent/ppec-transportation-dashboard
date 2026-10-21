import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { confirmStaffAction } from "@/modules/actions/confirm";
import { actionDepsFor } from "@/modules/actions/deps";
import { seedStandardScenario } from "@/modules/demo/seed";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { loadBoard } from "@/modules/plan/store";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { loadAgentConfig } from "../config";
import { createGateway } from "../gateway";
import { fakeProvider, toolCall } from "../providers/fake";
import { findLeaks } from "../redact";
import { dbContextAssembler } from "../run/assembler";
import { liveExecutors, liveProposalWriter } from "../run/exec/registry";
import { askAgent } from "./staff-ask";
import { readAgentThread } from "./thread";

/**
 * A WHOLE-LEG CARD, END TO END (ledger #89). Prod: "Plan the morning" drafted, then the reply read
 * "Van 1 has Mia, Ava, and [REDACTED:NAME]…" — the card's result handed the model real names, it
 * repeated them, and the reply's redaction wiped them. The real assembler, executors, proposal
 * writer and confirm path over a seeded site; only the model is scripted.
 */
let db: Db;
let close: () => Promise<void>;
const saved = { ...process.env };
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };
// 6:00 AM ET: the morning not yet planned, before any van leaves.
const NOW = new Date("2026-10-16T10:00:00.000Z");
const DATE = "2026-10-16";
let coordinator = "";
const prompts: string[] = [];
let asked: Awaited<ReturnType<typeof askAgent>>;

beforeAll(async () => {
  process.env = { ...saved, ...ENV };
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  coordinator = await seedStaff(db, "COORDINATOR", SITE);

  const execDeps = { db, scheduler: new VercelQueueScheduler(db, new FakeTransport(), () => NOW), transport: new FakeOutboxTransport() };
  const assemble = dbContextAssembler(db, { env: ENV });
  const deps = {
    db,
    gateway: createGateway(
      fakeProvider([
        toolCall("propose_plan_change", { leg: "AM", auto_plan: "whole_leg", note: "Plans the morning: every child in a van." }),
        toolCall("reply_to_staff", { summary: "The morning's ready to approve: C1 and C4 ride together and every van fits." }),
      ]),
      loadAgentConfig(ENV),
      { now: () => NOW.getTime() },
    ),
    assemble: async (input: Parameters<typeof assemble>[0]) => {
      const a = await assemble(input);
      prompts.push(a.prompt);
      return a;
    },
    executors: liveExecutors(execDeps),
    proposals: liveProposalWriter(execDeps),
    scheduler: execDeps.scheduler,
    now: () => NOW,
  };
  asked = await askAgent(db, { siteId: SITE, text: "plan routes for today", by: `staff:${coordinator}` }, {
    env: ENV,
    runner: () => ({ ok: true as const, refused: false, reason: null, deps }),
  });
}, 180_000);

afterAll(async () => {
  process.env = saved;
  await close();
});

const names = (text: string) => findLeaks(text).filter((f) => f.kind === "NAME");

describe("a whole-leg card the agent drafts (ledger #89)", () => {
  it("drafts the card and answers", () => {
    expect(asked.ok, JSON.stringify(asked)).toBe(true);
    if (asked.outcome !== "ran") throw new Error(asked.outcome);
    expect(asked.proposalId).toEqual(expect.any(String));
  });

  it("hands the model the card's result in tokens, never names", () => {
    expect(prompts.length).toBe(2);
    const second = prompts[1];
    expect(second).toMatch(/result seq=0 tool=propose_plan_change status=PROPOSED .*shows=.*→ Van/);
    expect(names(second)).toEqual([]);
    // The first turn was clean already: the plan up front is tokens (ledger #87).
    expect(names(prompts[0])).toEqual([]);
  });

  it("answers in first names, nothing redacted", async () => {
    if (asked.outcome !== "ran") throw new Error(asked.outcome);
    expect(asked.answer).not.toMatch(/REDACTED|\bC\d+\b/);
    const thread = await readAgentThread(db, SITE);
    const askId = asked.taskId;
    const answer = thread.items.find((i) => "id" in i && i.id === `${askId}:answer`);
    expect(answer && "text" in answer ? answer.text : "").toBe(asked.answer);
  });

  it("Approve saves the morning with every riding child in a van, and the card says how it ended", async () => {
    if (asked.outcome !== "ran" || !asked.proposalId) throw new Error("no card");
    const cardId = asked.proposalId;
    const answer = await confirmStaffAction(db, { userId: coordinator, approvalId: cardId, decision: "APPROVED", now: NOW });
    expect(answer.body.ok, JSON.stringify(answer.body)).toBe(true);

    const deps = actionDepsFor(db, SITE);
    const view = await loadBoard(deps.store!, SITE, DATE, "AM", deps.source);
    expect(view.version).toBeGreaterThan(0);
    expect(view.day.riders.filter((r) => view.plan[r.token]?.bucket !== "VAN").map((r) => r.name)).toEqual([]);

    const thread = await readAgentThread(db, SITE);
    expect(thread.items.some((i) => "id" in i && i.id === `${cardId}:done`)).toBe(true);
    expect(thread.waiting).toBe(0);
  });
});
