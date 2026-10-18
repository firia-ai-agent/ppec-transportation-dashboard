/**
 * **Veri's agent gate, check 2: every outbound message is a mock.**
 *
 * It lands in the outbox and on the simulated phone, and no real SMS or Teams adapter is called —
 * which has to be provable about the *wiring*, not just about the test setup. A suite that passes
 * its own `SimMessagingProvider` in proves nothing about what the deployed app does; so the
 * behavioural half below drives `outboxDeps()`'s own provider class, with `fetch` stubbed to throw
 * so that any adapter reaching for a network is a failure rather than a surprise bill.
 *
 * Four parts:
 *
 *  1. **The wiring.** `outboxDeps()` — the one `DrainDeps` every route uses — builds
 *     `DbSimMessagingProvider`, whose `name` is `SIM`. There is exactly one other implementation
 *     of the seam in `src/` and it is the Twilio *stub*, which refuses.
 *  2. **The absence.** No Teams adapter and no Twilio SDK exist to be called: not in `package.json`,
 *     not in `src/`. `STAFF` is the audience §11.2 gives for "tell a person", and `followup.ts`
 *     answers it with a task rather than a message, so the one channel that would need Teams has
 *     no egress path at all.
 *  3. **The send.** An agent run queues a follow-up, the real outbox drains it to the real
 *     `DbSimMessagingProvider`, and what happens is a row in `ops.message` marked `SIM` /
 *     `SIMULATED` — the same row the phone panel reads. No `fetch`, in any of it.
 *  4. **The phone panel sees it.** The bubble the founder clicks through to is that row, read back
 *     through `messaging/mailbox.ts`, with the outbox's own rendered body.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { testIdentityGateway } from "@/test/identity-gateway";

/**
 * The suites' identity gateway (S1-6). `read_message`, the capability report and the drain's
 * consent check all ask `IdentityGateway` now rather than the connection — and this one answers
 * from the rows `seedAgentScenario` just wrote. See src/test/identity-gateway.ts for why it is in
 * memory rather than `dbIdentityGateway` over this handle.
 */
const GATEWAY = testIdentityGateway({ pepper: PEPPER });
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { personaMessages, resolvePersona } from "@/modules/messaging/mailbox";
import { dbIdentityGateway } from "@/modules/identity/gateway";
import { DbSimMessagingProvider, SIM_STATUS_JOB_KIND, simStatusHandler } from "@/modules/messaging/sim-provider";
import { renderForSend, renderTemplate } from "@/modules/messaging/templates";
import { type DrainDeps, drain } from "@/modules/outbox/outbox";
import { dbRecipientAuthorizer } from "@/modules/outbox/policy";
import { twilioStub } from "@/modules/outbox/provider";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import { TEST_NOW } from "@/test/clock";
import { F1_NUMBER, PEPPER, seedStaff } from "@/test/messaging";
import { decideApproval, pendingApprovals } from "@/modules/approvals/decide";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { freshDb } from "@/test/pglite";
import { toolCall } from "./providers/fake";
import type { PolicyContext } from "./policy";
import type { TierFacts } from "./run/context";
import { liveHarness } from "./run/exec/live-harness";
import type { Trigger } from "./run/triggers";

/* ───────── part 1 + 2: what exists to be called, and what does not ───────── */

const SRC_DIR = path.resolve(__dirname, "../..");
const REPO_DIR = path.resolve(SRC_DIR, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(SRC_DIR)
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  .map((f) => path.relative(SRC_DIR, f).split(path.sep).join("/"));

const read = (file: string) => readFileSync(path.join(SRC_DIR, file), "utf8");

/**
 * A class or object that *is* a provider behind the ADR-006 messaging seam — `implements`, or a
 * value annotated with it. Deliberately not a bare `: MessagingProvider` type reference, which is
 * how `outbox.ts` declares the field it is handed and not an implementation of anything.
 */
const IMPLEMENTS_THE_SEAM = /implements\s+MessagingProvider\b|:\s*MessagingProvider\s*=/;

describe("check 2, part 1: the only messaging provider the app wires is the simulator", () => {
  it("outboxDeps builds the SIM provider, and says so in its own source", () => {
    const deps = read("modules/outbox/deps.ts");
    expect(deps).toContain("DbSimMessagingProvider");
    expect(deps).not.toMatch(/twilio|teams|graph/i);
    expect(new DbSimMessagingProvider({} as never, {} as never).name).toBe("SIM");
  });

  it("every implementation of the seam in src/ is named here, and all but one are simulators", () => {
    const implementers = sourceFiles.filter((f) => IMPLEMENTS_THE_SEAM.test(read(f))).sort();
    expect(implementers).toEqual([
      // The in-memory double the outbox's own tests drive…
      "modules/outbox/provider.ts",
      // …the seam itself, and the simulator the app runs.
      "modules/messaging/sim-provider.ts",
    ].sort());
  });

  it("the Twilio stub refuses rather than sends, so wiring it by mistake sends nothing", async () => {
    expect(twilioStub.name).toBe("TWILIO");
    await expect(
      twilioStub.send({} as never, { signal: new AbortController().signal }),
    ).rejects.toThrow(/not enabled in P1/);
  });
});

describe("check 2, part 2: there is no Teams adapter and no SMS vendor SDK to call", () => {
  it("package.json carries no messaging vendor dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_DIR, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const named = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(named.filter((d) => /twilio|botframework|botbuilder|microsoft-graph|@azure|sendgrid|vonage|nexmo/i.test(d))).toEqual([]);
  });

  it("no module in src/ posts to a vendor messaging API", () => {
    const vendorCalls = sourceFiles
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => /api\.twilio\.com|graph\.microsoft\.com|smtp|outlook\.office/i.test(read(f)));
    expect(vendorCalls).toEqual([]);
  });

  it("the STAFF audience is a task, not an egress path (§10.4: staff are reached on Teams, B-12)", () => {
    const followup = read("modules/agent/run/exec/followup.ts");
    // The code says it out loud, and `followup.test.ts` drives it: a STAFF follow-up opens a task.
    expect(followup).toMatch(/STAFF.*not a message|STAFF\` is deliberately not a message/s);
    expect(followup).toContain("STAFF_NOTICE_TASK_CATEGORY");
  });
});

/* ───────── parts 3 + 4: the send, over a real database, with no network ───────── */

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
let fetchCalls: number;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
  fetchCalls = 0;
  // The stub is the assertion: a real adapter reaching for the network fails the test by name
  // rather than by timing out against a host that is not there.
  vi.stubGlobal("fetch", (...args: unknown[]) => {
    fetchCalls += 1;
    throw new Error(`a messaging adapter called fetch(${String(args[0])}) — nothing here may leave the box`);
  });
}, 60_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const trigger = (): Trigger => ({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId} scopes=RECEIVE_TRANSPORT_UPDATES`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["is the van still coming"],
  t4: "channel=SMS locale=en-US",
});

const policy = (): PolicyContext => ({
  scope: sc.scope,
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
});

const VARS = () => ({ legDate: sc.serviceDate, reasonCode: "FAMILY_REQUEST" });

/** The run every test in this half drives: one allow-listed follow-up, then a staff note. */
const script = () => [
  toolCall("send_followup", {
    audience: "GUARDIAN_OF_CHILD",
    subject_token: sc.children[0],
    template_id: "leg.canceled",
    vars: VARS(),
  }),
  toolCall("summarize_thread_for_staff", { thread_id: sc.threadId, summary: "Guardian canceled a ride" }),
];

/**
 * The Approve button (S1-7, Firia 2026-10-18). `send_followup` proposes now, so the run leaves a
 * `MESSAGE_SEND` row and a coordinator's decision is what puts the message in the outbox. What
 * this file is about — that the message then goes to the SIMULATOR and never to a wire — is
 * unchanged, and is asserted after this.
 */
async function approveWaiting(): Promise<void> {
  const coordinator = await seedStaff(db, "COORDINATOR", sc.siteId);
  for (const p of await pendingApprovals(db, [sc.siteId])) {
    const answer = await decideApproval(db, new FakeOutboxTransport(), {
      userId: coordinator, approvalId: p.id, decision: "APPROVED", approvedText: p.text, now,
    });
    expect(answer.status).toBe(200);
  }
}

/** The real simulator, wired the way `outboxDeps()` wires it, with the test's clock and pepper. */
const simDeps = (): DrainDeps => ({
  provider: new DbSimMessagingProvider(db, new VercelQueueScheduler(db, new FakeTransport(), () => now), {
    clock: () => now,
    pepper: PEPPER,
  }),
  authorizer: dbRecipientAuthorizer(db),
  clock: () => now,
  timeoutMs: 500,
});

describe("check 2, part 3: a real send lands in the simulator, not on a wire", () => {
  it("drains to SIM, writes a SIMULATED outbound row, and never calls fetch", async () => {
    sc = await seedAgentScenario(db, { number: F1_NUMBER, receivedAt: now });
    const h = liveHarness({
    gateway: GATEWAY,
      db,
      script: script(),
      facts: facts(),
      policy: policy(),
      overrides: { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) },
      now: () => now,
    });
    expect((await h.start(trigger())).state).toBe("SUCCEEDED");
    await approveWaiting();

    const [queued] = (
      await db.query<{ id: string; state: string; channel: string }>(
        "SELECT id, state, channel FROM ops.outbound_message ORDER BY created_at",
        [],
      )
    ).rows;
    expect([queued.state, queued.channel]).toEqual(["QUEUED", "SMS_1TO1"]);

    expect(await drain(db, queued.id, simDeps())).toBe("SENT");

    const out = (
      await db.query<{ provider: string; source_mode: string; external_id: string; body_tokenized: string }>(
        "SELECT provider, source_mode, external_id, body_tokenized FROM ops.message WHERE direction = 'OUT'",
        [],
      )
    ).rows;
    expect(out.map((m) => [m.provider, m.source_mode])).toEqual([["SIM", "SIMULATED"]]);
    expect(out[0].external_id).toBe(`SIM-${queued.id}`);
    // The stored body is what was SENT, so it carries the 10DLC footer the send step appends
    // (`renderForSend`, Firia 11:00 PM ET, S1-5). The draft it was rendered from does not.
    expect(out[0].body_tokenized).toBe(renderForSend("leg.canceled", VARS()));
    expect(fetchCalls).toBe(0);
  });

  it("the delivery status is a durable job in our own tables, not a vendor webhook", async () => {
    sc = await seedAgentScenario(db, { number: F1_NUMBER, receivedAt: now });
    const h = liveHarness({
    gateway: GATEWAY,
      db,
      script: script(),
      facts: facts(),
      policy: policy(),
      overrides: { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) },
      now: () => now,
    });
    await h.start(trigger());
    await approveWaiting();
    const [queued] = (await db.query<{ id: string }>("SELECT id FROM ops.outbound_message", [])).rows;
    await drain(db, queued.id, simDeps());

    const [job] = (
      await db.query<{ kind: string; payload: { outboundMessageId: string; to: string } }>(
        "SELECT kind, payload FROM ops.job WHERE kind = $1",
        [SIM_STATUS_JOB_KIND],
      )
    ).rows;
    expect(job.kind).toBe(SIM_STATUS_JOB_KIND);
    expect(job.payload.to).toBe("DELIVERED");

    await db.tx((tx) => simStatusHandler(tx, { payload: job.payload } as never, () => {}));
    const [row] = (await db.query<{ state: string }>("SELECT state FROM ops.outbound_message", [])).rows;
    expect(row.state).toBe("DELIVERED");
    expect(fetchCalls).toBe(0);
  });
});

describe("check 2, part 4: the phone panel is reading that same simulated row", () => {
  it("the family's phone shows the message, in the outbox's own words", async () => {
    sc = await seedAgentScenario(db, { number: F1_NUMBER, receivedAt: now });
    const h = liveHarness({
    gateway: GATEWAY,
      db,
      script: script(),
      facts: facts(),
      policy: policy(),
      overrides: { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) },
      now: () => now,
    });
    await h.start(trigger());
    await approveWaiting();
    const [queued] = (await db.query<{ id: string }>("SELECT id FROM ops.outbound_message", [])).rows;
    await drain(db, queued.id, simDeps());

    const persona = await resolvePersona(db, { number: F1_NUMBER, pepper: PEPPER, gateway: dbIdentityGateway(db, { pepper: PEPPER }) });
    expect(persona?.contactToken).toBe(sc.contactToken);
    const shown = await personaMessages(db, persona!);
    const bubbles = shown.filter((m) => m.direction === "OUT");

    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].body).toBe(renderTemplate("leg.canceled", VARS()));
    expect(bubbles[0].reachedPhone).toBe(true);
    expect(bubbles[0].sourceMode).toBe("SIMULATED");
    expect(fetchCalls).toBe(0);
  });

  it("a message that never left the center is not drawn as if the family got it (demo step 10)", async () => {
    sc = await seedAgentScenario(db, { number: F1_NUMBER, receivedAt: now });
    await db.query(
      `INSERT INTO ops.suppression (id, site_id, contact_token, scope, consent_event_id, created_by, updated_by, source_mode)
       VALUES (gen_random_uuid(), $1, $2, 'ALL', gen_random_uuid(), 'test', 'test', 'SIMULATED')`,
      [sc.siteId, sc.contactToken],
    );
    const h = liveHarness({
    gateway: GATEWAY,
      db,
      script: script(),
      facts: facts(),
      policy: policy(),
      overrides: { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) },
      now: () => now,
    });
    await h.start(trigger());
    await approveWaiting();

    const queued = (await db.query<{ id: string }>("SELECT id FROM ops.outbound_message", [])).rows;
    for (const q of queued) expect(await drain(db, q.id, simDeps())).toBe("BLOCKED_EGRESS");

    const persona = await resolvePersona(db, { number: F1_NUMBER, pepper: PEPPER, gateway: dbIdentityGateway(db, { pepper: PEPPER }) });
    const shown = persona ? await personaMessages(db, persona) : [];
    for (const bubble of shown.filter((m) => m.direction === "OUT")) expect(bubble.reachedPhone).toBe(false);
    expect(
      (await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.message WHERE direction = 'OUT'", [])).rows[0].n,
    ).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});
