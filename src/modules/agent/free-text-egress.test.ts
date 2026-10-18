/**
 * **Veri's agent gate, check 1: free text to a parent cannot go out without staff approval.**
 *
 * The *policy* half of that sentence is already held down twice over — `free-text-approval.test.ts`
 * mocks a free-text sender into the catalog and proves the gate closes over it,
 * `live-approval-tiers.test.ts` proves the tier does not change when a live model answers, and
 * `policy.test.ts` §11.2 walks the prohibited list. None of those is what Veri asked for here.
 * The ask was "**no path** skips approval, including direct API posts" — a question about the
 * *routes*, not about `evaluate()`. So this file works from the outside in, and each of the four
 * parts below is a different way in:
 *
 *  1. **The HTTP surface.** No route and no server action can put a message in the outbox at all.
 *     The egress door is `outbox.enqueue`, every caller of it is a `src/modules/**` executor, and
 *     a scan says so by name — so "post a text to this endpoint" is not a thing the app has.
 *  2. **The door itself.** `EnqueueInput` carries a template id and vars, and nothing on it can
 *     hold prose: an unknown template is refused, an undeclared var is refused, and a sentence in
 *     a declared var is refused by that var's own value rule.
 *  3. **The live path, over a real database**, with the real gateway, the real policy engine, the
 *     real executors and the real outbox: a model that tries prose three ways queues nothing.
 *  4. **…and the templated follow-up that may.** The same path, the same run, one allow-listed
 *     template id and two codes: queued, drained, delivered, with no approval anywhere — which is
 *     the second half of Veri's sentence and would be worth nothing if part 3 were the whole file.
 *
 * Part 5 is the direct post itself: a parent's text arriving on the one public write endpoint
 * (`/api/webhooks/sms` → `ingestInbound`) produces no outbound message carrying a word of it, and
 * the one inbound that *is* answered automatically (HELP, MSG-04) is answered with fixed copy out
 * of `messaging/templates.ts`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { MESSAGE_SEND_KIND } from "@/modules/approvals/message-send";
import { DROPOFF_REPLY_TEMPLATE } from "@/modules/approvals/dropoff-change";
import { toolDef } from "./tools";
import { testIdentityGateway } from "@/test/identity-gateway";

/**
 * The suites' identity gateway (S1-6). `read_message`, the capability report and the drain's
 * consent check all ask `IdentityGateway` now rather than the connection — and this one answers
 * from the rows `seedAgentScenario` just wrote. See src/test/identity-gateway.ts for why it is in
 * memory rather than `dbIdentityGateway` over this handle.
 */
const GATEWAY = testIdentityGateway({ pepper: PEPPER });
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { ingestInbound, parseInboundForm, type InboundDeps } from "@/modules/messaging/inbound";
import { HELP_REPLY_BODY, HELP_REPLY_TEMPLATE, renderTemplate } from "@/modules/messaging/templates";
import { TEMPLATE_VARS, disallowedVars } from "@/modules/outbox/outbox";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import { TEST_NOW } from "@/test/clock";
import { F1_NUMBER, PEPPER } from "@/test/messaging";
import { freshDb } from "@/test/pglite";
import { SIM_CENTER_NUMBER } from "@/modules/messaging/sim-numbers";
import { freeText, toolCall } from "./providers/fake";
import type { ProviderResponseBody } from "./providers/provider";
import type { PolicyContext } from "./policy";
import type { TierFacts } from "./run/context";
import { type LiveHarness, liveHarness } from "./run/exec/live-harness";
import type { Trigger } from "./run/triggers";

/* ───────── part 1: the HTTP surface has no door to the outbox ───────── */

const SRC_DIR = path.resolve(__dirname, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(SRC_DIR)
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  .map((f) => path.relative(SRC_DIR, f).split(path.sep).join("/"))
  // Test helpers (`src/test/**`) seed rows of their own and are not part of the running app.
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx") && !f.startsWith("test/"));

/** Comments stripped, as in `no-network.test.ts`: prose about enqueueing is not a call. */
function code(file: string): string {
  return readFileSync(path.join(SRC_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * A file that composes a message: it writes `ops.outbound_message` itself, or it calls **the
 * outbox's** `enqueue` — which means importing that name from that module.
 *
 * The import is part of the test, and has to be. A bare `/\benqueue\s*\(/` is a search for a
 * *word*, and #73 landed a second function with that word on it: `domain/plan/pending.ts`'s
 * `enqueue(queue, move)`, the board's in-memory list of drags waiting for a Save, called from
 * `PlanBoard.tsx`. Nothing about it touches a message, a template or a phone — but on the word
 * alone it read as a client component queueing a family text, which is the exact thing this file
 * exists to forbid. Naming the door by its module rather than by its verb is the narrower check:
 * a route that really did reach the outbox has to import from it to do so, and the `INSERT`
 * branch catches anything that goes around the function instead.
 */
const IMPORTS_THE_OUTBOX = /import\s*\{[^}]*\benqueue\b[^}]*\}\s*from\s*["'][^"']*outbox\/outbox["']/;
const WRITES_THE_TABLE = /INSERT\s+INTO\s+ops\.outbound_message/i;
const CALLS_ENQUEUE = /\benqueue\s*\(/;
const QUEUES_A_MESSAGE = (source: string): boolean =>
  WRITES_THE_TABLE.test(source) || (IMPORTS_THE_OUTBOX.test(source) && CALLS_ENQUEUE.test(source));
/** A file that hands a message to a transport: the second half of a send, after the outbox. */
const SENDS_A_MESSAGE = /\bdrain\s*\(|\bprovider\s*\.\s*send\s*\(/;

const queueingFiles = sourceFiles.filter((f) => QUEUES_A_MESSAGE(code(f)));

describe("check 1, part 1: no route and no server action can put a message in the outbox", () => {
  it("the scan reads the tree it claims to read", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(sourceFiles).toEqual(
      expect.arrayContaining([
        "app/api/webhooks/sms/route.ts",
        "app/(app)/family-texts/actions.ts",
        "modules/outbox/outbox.ts",
        "modules/agent/run/exec/followup.ts",
      ]),
    );
  });

  it("every caller of the egress door is a domain module, and none of them is a route", () => {
    /*
     * The door itself, the §11.2 executors that are allowed through it, the ETA sweeper, the
     * fixed-copy HELP answer, and SURF-05's approval decision. Each one composes from a template id
     * and codes; none of them takes copy from a caller. If this list grows, the thing that grew has
     * to be read.
     *
     * The list got SHORTER on Firia's S1-7 ruling (2026-10-18), which is the direction a list like
     * this is allowed to move without anybody reading it twice. `exec/clarify.ts` and
     * `exec/followup.ts` are off it: the two tools that reached a family no longer queue anything
     * at all — they write a `MESSAGE_SEND` proposal, and `modules/approvals/decide.ts` queues it
     * when a person approves. So the agent's own remaining doors are the therapist alert and the
     * dispatcher question, neither of which is a text to a family.
     *
     * `modules/approvals/decide.ts` is the newest and is the reason this list is worth having. It
     * is what a coordinator's "Approve and send" runs, and it is a **module** rather than the
     * screen's own file precisely because of the assertion on the next line: a decision model that
     * queued from under `src/app/` would have been the first exception to "no server action may put
     * a message in the outbox", and the first exception is how a rule stops being one. The copy it
     * sends is the template id and the vars the agent's proposal row already carried, plus one
     * clock time a coordinator may edit — regex-checked, and a var no template will render as prose.
     */
    expect(queueingFiles.sort()).toEqual([
      "modules/agent/run/exec/capability.ts",
      "modules/agent/run/exec/therapist.ts",
      "modules/approvals/decide.ts",
      "modules/messaging/eta-notice.ts",
      "modules/messaging/inbound.ts",
      "modules/outbox/outbox.ts",
    ]);
    expect(queueingFiles.filter((f) => f.startsWith("app/"))).toEqual([]);
  });

  it("the routes that touch the outbox only drain what is already in it", () => {
    const appSenders = sourceFiles.filter((f) => f.startsWith("app/") && SENDS_A_MESSAGE.test(code(f)));
    // Draining is the outbox's own machinery: it re-checks consent, staleness and the vars, and
    // it cannot invent a message that is not already a row. Composing is what routes may not do.
    expect(appSenders.sort()).toEqual(["app/api/queues/outbox/route.ts"]);
    for (const f of appSenders) expect(QUEUES_A_MESSAGE(code(f)), f).toBe(false);
  });

  it("the two phone-panel server actions write nothing at all", () => {
    const actions = code("app/(app)/family-texts/actions.ts");
    expect(QUEUES_A_MESSAGE(actions)).toBe(false);
    expect(SENDS_A_MESSAGE.test(actions)).toBe(false);
    expect(/INSERT\s+INTO|UPDATE\s+ops\./i.test(actions)).toBe(false);
  });

  it("would notice a route that acquired one", () => {
    const importLine = 'import { enqueue } from "@/modules/outbox/outbox";';
    expect(QUEUES_A_MESSAGE(`${importLine}\nawait enqueue(tx, afterCommit, transport, msg);`)).toBe(true);
    expect(QUEUES_A_MESSAGE("INSERT INTO ops.outbound_message (id) VALUES ($1)")).toBe(true);
    expect(SENDS_A_MESSAGE.test("await provider.send(payload, { signal });")).toBe(true);
    /*
     * And the two halves are both required, which is what keeps #73's board queue out of the
     * list: a call with no import of this door is some other function with the same verb, and an
     * import with no call is a module that has not used it yet.
     */
    expect(QUEUES_A_MESSAGE("await enqueue(queue, { childToken, bucket, vanId });")).toBe(false);
    expect(QUEUES_A_MESSAGE(importLine)).toBe(false);
  });
});

/* ───────── part 2: nothing on the egress door's input can carry prose ───────── */

/** What a model, a route or a staff form would try to smuggle a sentence through. */
const PROSE = "Sure — I asked the driver to drop at grandma's at 5, see you then!";
/** The var names a free-text field would plausibly arrive under. */
const PROSE_VAR_NAMES = ["body", "text", "message", "note", "reason", "summary", "childFirstName"] as const;

/**
 * THE ONE TEMPLATE WHOSE BODY IS PROSE — and the one var on it that may be (Firia, 2026-10-18
 * 11:04 AM ET).
 *
 * §11.2 bans free text to parents **without human approval**, and `dropoff.reply` is the approved
 * path: the only writer is `propose_dropoff_change`'s proposal row and the only sender is
 * `approvals/decide.ts`, after a director or a coordinator has pressed Approve on those exact
 * words (`decideApproval` refuses a decision whose text does not match what the row renders) —
 * or on their own edit of them (Edit = the message text, user ruling 2026-10-18), which fills
 * this same var and is held to the same rule below, checked in `decideApproval` before anything
 * is written.
 *
 * So the blanket assertions below are scoped around this pair, and around nothing else: every
 * other template is held to the same ban it was, this template is held to the ban on every *other*
 * var name, and the reply var itself is held to its own shape — bounded length, no phone number,
 * no address, no URL, no uuid, no internal code, no `PPEC:` prefix (`messaging/reply-text.ts`),
 * asserted in the describe that follows this one. Two things went from "nothing can" to "one
 * thing can, and here is what it cannot"; nothing went from banned to unchecked.
 */
const APPROVED_REPLY_TEMPLATE = DROPOFF_REPLY_TEMPLATE;
const APPROVED_REPLY_VAR = "replyText";
/** Is this (template, var) the approved-reply pair? Everything else is still prose-free. */
const isApprovedReply = (templateId: string, name: string) =>
  templateId === APPROVED_REPLY_TEMPLATE && name === APPROVED_REPLY_VAR;

describe("check 1, part 2: the egress door takes a template id and codes, never prose", () => {
  it("refuses a template that is not on the outbox's own list", () => {
    expect(disallowedVars("free.text", { body: PROSE })).toEqual(["body"]);
    expect(disallowedVars("dropoff.changed.v2", {})).toEqual([]);
    expect(TEMPLATE_VARS["free.text"]).toBeUndefined();
  });

  it.each(Object.keys(TEMPLATE_VARS))("refuses a prose var on %s, under every name it might use", (templateId) => {
    for (const name of PROSE_VAR_NAMES) {
      expect(disallowedVars(templateId, { [name]: PROSE }), `${templateId}.${name}`).toContain(name);
    }
  });

  it.each(Object.entries(TEMPLATE_VARS).filter(([, vars]) => Object.keys(vars).length > 0))(
    "refuses prose in %s's own declared vars, which are codes and clock times",
    (templateId, vars) => {
      for (const name of Object.keys(vars)) {
        if (isApprovedReply(templateId, name)) continue;
        expect(disallowedVars(templateId, { [name]: PROSE }), `${templateId}.${name}`).toEqual([name]);
      }
    },
  );

  it("no template declares a var whose rule a sentence can satisfy, bar the approved reply", () => {
    for (const [templateId, vars] of Object.entries(TEMPLATE_VARS)) {
      for (const [name, rule] of Object.entries(vars)) {
        if (isApprovedReply(templateId, name)) continue;
        expect(rule(PROSE), `${templateId}.${name}`).toBe(false);
        expect(rule("your child is running late because the van broke down"), `${templateId}.${name}`).toBe(false);
      }
    }
  });

  it("is the ONLY pair that takes prose: one template, one var name", () => {
    // The exception is enumerated rather than described, so a second one cannot appear quietly.
    const prosePairs = Object.entries(TEMPLATE_VARS).flatMap(([templateId, vars]) =>
      Object.entries(vars)
        .filter(([, rule]) => rule(PROSE) || rule("yes that is fine, see you then"))
        .map(([name]) => `${templateId}.${name}`),
    );
    expect(prosePairs).toEqual([`${APPROVED_REPLY_TEMPLATE}.${APPROVED_REPLY_VAR}`]);
    // And on that template every other prose name is refused exactly as it is everywhere else.
    for (const name of PROSE_VAR_NAMES) {
      expect(disallowedVars(APPROVED_REPLY_TEMPLATE, { [name]: PROSE }), name).toContain(name);
    }
  });
});

/**
 * The shape of the one prose field, which is what replaces the blanket ban on this path (Firia,
 * 11:04 AM ET). A reply is words a person approved, so what it may not contain is everything a
 * family's text must never carry whoever wrote it.
 */
describe("check 1, part 2b: the approved reply is bounded and still carries no PHI", () => {
  const rule = TEMPLATE_VARS[APPROVED_REPLY_TEMPLATE][APPROVED_REPLY_VAR];

  it("takes the reply the ruling asks for: warm, short, and the time the parent asked for", () => {
    const reply = "Hi Dara, yes, we'll drop Noah off at 5 today. Thanks for letting us know!";
    expect(rule(reply)).toBe(true);
    expect(disallowedVars(APPROVED_REPLY_TEMPLATE, { replyText: reply })).toEqual([]);
    // Behind the sender prefix every family text carries (COPY-GUIDE §5); the words are hers.
    expect(renderTemplate(APPROVED_REPLY_TEMPLATE, { replyText: reply })).toBe(`PPEC: ${reply}`);
  });

  it.each([
    ["a phone number", "Yes, that is fine. Call the driver on (561) 555-0177 if you need to."],
    ["a street address", "Yes, we will drop at 2216 Jog Rd instead."],
    ["a link", "Yes — track the van at https://example.com/track"],
    ["an internal code", "Yes, we will set the leg to BOARDED_VERIFIED at OKEE-PARK."],
    ["a uuid", "Yes, approved as 0199a1b2-c3d4-7000-8000-00000000abcd."],
    ["the machine's own prefix", "PPEC: Yes, that works."],
    ["a placeholder", "Yes, {childName} gets off at 5."],
    ["a line break", "Yes, that works.\nSee you then."],
    ["nothing at all", "   "],
    ["more than 320 characters", `Yes, ${"that works. ".repeat(40)}`],
    // PPE-97: the shapes a number or a link takes when somebody is trying to get it past a filter.
    ["a spaced-out phone number", "Yes. Text us at 5 6 1 5 5 5 0 1 7 7 if anything changes."],
    ["a full-width phone number", "Yes. Text us at ５６１５５５０１７７ if anything changes."],
    ["digits run together", "Yes. Call 5615550177 when you are home."],
    ["a domain spelled out", "Yes. Details are at example dot com."],
    ["a bare domain", "Yes. Pay the fee at tokos.app/pay first."],
  ])("refuses a reply carrying %s", (_label, reply) => {
    expect(rule(reply)).toBe(false);
    expect(disallowedVars(APPROVED_REPLY_TEMPLATE, { replyText: reply })).toEqual([APPROVED_REPLY_VAR]);
    // Refused at render too, so a row written around the door sends nothing (defence in depth).
    expect(() => renderTemplate(APPROVED_REPLY_TEMPLATE, { replyText: reply })).toThrow();
  });

  it("is refused at the gateway as a tool argument before it can ever become a row", () => {
    const args = (reply: unknown) => ({
      leg_id: "L-C1-PM",
      requested_dropoff_time: "17:00",
      requested_stop_token: null,
      rationale_code: "PARENT_REQUEST",
      reply,
      alert_text: "The family asked to move the afternoon drop-off to 5 PM.",
      source_message_id: "MSG-1",
      expected_version: 1,
    });
    const schema = toolDef("propose_dropoff_change")!.schema;
    expect(schema.safeParse(args("Hi Dara, yes, five works. Thanks for letting us know!")).success).toBe(true);
    expect(schema.safeParse(args("PPEC: Yes.")).success).toBe(false);
    expect(schema.safeParse(args("Call us on 561-555-0177.")).success).toBe(false);
    // And the reply is not optional: the card is the model's sentence or the copy fallback, never
    // the fixed template dressed up as a draft (Firia, 11:04 AM ET).
    expect(schema.safeParse({ ...args("x"), reply: undefined }).success).toBe(false);
  });
});

/* ───────── parts 3–5: the live path, over a real database ───────── */

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const trigger = (): Trigger => ({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId} scopes=RECEIVE_TRANSPORT_UPDATES`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["can you text my mother and tell her we are running late"],
  t4: "channel=SMS locale=en-US",
});

const policy = (): PolicyContext => ({
  scope: sc.scope,
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
});

const NOTE_TURN = () =>
  toolCall("summarize_thread_for_staff", { thread_id: sc.threadId, summary: "Guardian asked for a change" });
const NOTE_EXECUTOR = { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) };

const harness = (script: readonly ProviderResponseBody[]): LiveHarness =>
  liveHarness({
    gateway: GATEWAY,
    db,
    script: [...script, NOTE_TURN()],
    facts: facts(),
    policy: policy(),
    overrides: NOTE_EXECUTOR,
    now: () => now,
  });

const outbound = async () =>
  (
    await db.query<{ template_id: string; vars: Record<string, unknown>; state: string; recipient_token: string }>(
      "SELECT template_id, vars, state, recipient_token FROM ops.outbound_message ORDER BY created_at",
      [],
    )
  ).rows;

const approvals = async () =>
  (await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.approval_request", [])).rows[0].n;

describe("check 1, part 3: a model that tries prose queues nothing", () => {
  it("answers the family in prose instead of calling a tool: the gateway refuses the turn", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([freeText(PROSE)]);
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect(r.reason).toMatch(/gateway refused the turn/);
    expect(await outbound()).toEqual([]);
    expect(h.provider.sent).toEqual([]);
    expect(h.gateways.at(-1)!.auditLog.at(-1)!.outcome).toBe("REJECTED_FREE_TEXT");
  });

  it("smuggles a sentence into a sending tool as an extra argument: refused before the policy engine", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([
      toolCall("send_followup", {
        audience: "GUARDIAN_OF_CHILD",
        subject_token: sc.children[0],
        template_id: "leg.canceled",
        vars: { legDate: sc.serviceDate, reasonCode: "FAMILY_REQUEST" },
        body: PROSE,
      }),
    ]);
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect(await outbound()).toEqual([]);
    expect(h.provider.sent).toEqual([]);
    // `strictObject`: an argument the model invented is refused whole, not stripped off a message
    // that then goes out.
    expect(h.gateways.at(-1)!.auditLog.at(-1)!.outcome).toBe("REJECTED_INVALID_ARGS");
  });

  it("writes the sentence into a declared var instead: the policy engine blocks it, nothing queued", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([
      toolCall("send_followup", {
        audience: "GUARDIAN_OF_CHILD",
        subject_token: sc.children[0],
        template_id: "leg.canceled",
        vars: { legDate: sc.serviceDate, reasonCode: PROSE.slice(0, 60) },
      }),
    ]);
    await h.start(trigger());

    expect(await outbound()).toEqual([]);
    expect(h.provider.sent).toEqual([]);
    const [call] = (
      await db.query<{ policy_decision: string; status: string }>(
        "SELECT policy_decision, status FROM ops.agent_tool_call ORDER BY seq",
        [],
      )
    ).rows;
    expect(call.policy_decision).toMatch(/^BLOCK:/);
    expect(call.status).not.toBe("EXECUTED");
  });

  it("names a template the tool's own allow-list does not carry: refused at the gateway", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([
      toolCall("send_followup", {
        audience: "GUARDIAN_OF_CHILD",
        subject_token: sc.children[0],
        template_id: "free.text",
        vars: { body: PROSE },
      }),
    ]);
    await h.start(trigger());

    expect(await outbound()).toEqual([]);
    expect(h.provider.sent).toEqual([]);
  });
});

/**
 * PART 4 — …and the templated follow-up that **a person releases**.
 *
 * This part used to read "a templated follow-up goes out on the agent's own authority", and it
 * was the second half of Veri's sentence: part 3 would have been worth nothing if nothing could
 * ever be sent. Firia's S1-7 ruling (2026-10-18) changed what that half is. A templated message
 * is still a message to a family, so `send_followup` is `human` tier with a `propose` effect now
 * — the run queues nothing at all, and a coordinator's approval is what puts the text in the
 * outbox (`modules/approvals/decide.ts`).
 *
 * So the shape of the claim is the same and the authority moved: one allow-listed template, two
 * codes, no prose anywhere — queued, drained, delivered — with **an approval in the middle of it
 * rather than none**. The assertion that nothing reaches the outbox before that approval is the
 * one worth having, and it is the first one below.
 */
describe("check 1, part 4: a templated follow-up goes out when a person releases it (S1-7)", () => {
  it("proposes instead of queueing: nothing is in the outbox before a person approves", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([
      toolCall("send_followup", {
        audience: "GUARDIAN_OF_CHILD",
        subject_token: sc.children[0],
        template_id: "leg.canceled",
        vars: { legDate: sc.serviceDate, reasonCode: "FAMILY_REQUEST" },
      }),
    ]);
    const r = await h.start(trigger());
    expect(r.state).toBe("SUCCEEDED");

    // NOTHING queued, and nothing sent — the whole of the ruling, in two lines.
    expect(await outbound()).toEqual([]);
    expect(h.provider.sent).toEqual([]);
    // One row for a person instead, of the message kind.
    expect(await approvals()).toBe(1);
    const row = await db.query<{ proposal: { kind?: string; template_id?: string; recipient_tokens?: string[] } }>(
      "SELECT proposal FROM ops.approval_request",
      [],
    );
    expect(row.rows[0].proposal.kind).toBe(MESSAGE_SEND_KIND);
    expect(row.rows[0].proposal.template_id).toBe("leg.canceled");
    // The recipients were computed from the audience and the subject, not named by the model.
    expect((row.rows[0].proposal.recipient_tokens ?? []).length).toBeGreaterThan(0);
  });

  it("and the words a person would be approving carry no prose", async () => {
    // The body is still the outbox's own, filled from codes — which is what part 4 was always
    // about. It is rendered here through the renderer both the card and the outbox use.
    const body = renderTemplate("leg.canceled", { legDate: "2026-10-14", reasonCode: "FAMILY_REQUEST" });
    expect(body).not.toContain(PROSE);
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("check 1, part 5: a direct post of a parent's text sends nothing back in its own words", () => {
  let deps: InboundDeps;
  let transport: FakeOutboxTransport;

  const post = (body: string, sid: string) => {
    const raw = new URLSearchParams({ MessageSid: sid, From: F1_NUMBER, To: SIM_CENTER_NUMBER, Body: body }).toString();
    const parsed = parseInboundForm(new URLSearchParams(raw));
    if ("error" in parsed) throw new Error(parsed.error);
    return ingestInbound(db, deps, raw, parsed.form);
  };

  beforeEach(async () => {
    transport = new FakeOutboxTransport();
    // S1-6: the webhook resolves its sender through the gateway, not through this connection.
    deps = { pepper: PEPPER, transport, clock: () => now, gateway: GATEWAY };
    sc = await seedAgentScenario(db, { number: F1_NUMBER, receivedAt: now });
  });

  it("an ordinary text, posted straight at the webhook's handler, queues nothing", async () => {
    const r = await post(PROSE, "SM-free-text");
    expect(r.status).toBe(200);
    expect(await outbound()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it("the one inbound that is answered automatically is answered with fixed copy (MSG-04)", async () => {
    const r = await post("HELP", "SM-help");
    expect(r.status).toBe(200);

    const queued = await outbound();
    expect(queued.map((m) => m.template_id)).toEqual([HELP_REPLY_TEMPLATE]);
    // No vars at all: there is nowhere for the sender's words to ride along.
    expect(queued[0].vars).toEqual({});
    expect(renderTemplate(HELP_REPLY_TEMPLATE, {})).toBe(HELP_REPLY_BODY);
    expect(HELP_REPLY_BODY).not.toContain("grandma");
  });

  it("the family's own words are kept as evidence on the inbound row, and only there", async () => {
    await post(PROSE, "SM-evidence");
    const inbound = (
      await db.query<{ direction: string; body_tokenized: string }>(
        "SELECT direction, body_tokenized FROM ops.message WHERE external_id = 'SM-evidence'",
        [],
      )
    ).rows;
    expect(inbound.map((m) => m.direction)).toEqual(["IN"]);
    expect(inbound[0].body_tokenized).toContain("grandma");
    expect(await outbound()).toEqual([]);
  });
});
