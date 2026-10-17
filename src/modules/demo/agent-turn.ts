/**
 * One agent turn over the demo scenario, with no database (PRD §18.2 steps 9–10, AT-01, AT-09).
 *
 * The *live* path is wired where it belongs — an inbound SMS writes a message, starts a run and
 * the queue drives it (`run/inbound-hook.ts`, `run/assembler.ts`, `/api/queues/agent`). This
 * module is the same seam, driven synchronously over the fixtures, for the one thing that path
 * cannot do on a preview deployment: be clicked. Previews share the one production database
 * read-only (DECISION-LEDGER #43), so a webhook there cannot write a message, let alone a run —
 * and a founder still has to be able to type a parent's text and watch what the assistant does
 * with it.
 *
 * Nothing about it is a mock-up. Every piece is the real one:
 *
 *  - the **prompt** is §11.1's, built by `tierPrompt` from tokenized tiers (the same shape the
 *    database-backed assembler produces, from the same fixtures the board reads);
 *  - the **vendor** is the configured OpenRouter model, with the key read from the environment
 *    inside the adapter and never seen here (`chooseProvider` → `providers/remote.ts`), falling
 *    back to the PRD §18.1 keyword parser when the key is absent or every model fails —
 *    *labelled* either way, because a degraded answer that looks live is the one dishonest thing
 *    this screen could do;
 *  - the **gateway** is the real one, so the prompt is validated token-only, the response must be
 *    exactly one schema-valid catalog tool call, and the audit row carries hashes only;
 *  - the **policy engine** is the real one, so what comes back is §11.2's verdict — and a
 *    `human`-tier call is a PROPOSAL that mutates nothing and sends nothing until a person signs
 *    the exact call (`approvalKey`).
 *
 * What is *not* here: any write. A turn returns a decision; applying one is `approveDropoff`
 * below, which computes what the change would be and renders the templated confirmation the
 * family would get — the same template, through the same renderer, as every other outbound text.
 */
import { localTimeOn, type ServiceDay } from "@/domain/board/day";
import { plannedWindowFor } from "@/domain/board/scenario";
import { formatClock24, formatWindow, windowFor } from "@/domain/eta/eta";
import { loadAgentConfig } from "@/modules/agent/config";
import { createGateway, GatewayError } from "@/modules/agent/gateway";
import { approvalKey, evaluate, familyScope, type PolicyDecision } from "@/modules/agent/policy";
import { chooseProvider } from "@/modules/agent/run/deps";
import { tierPrompt } from "@/modules/agent/run/context";
import { tokenizeNames } from "@/modules/identity/names";
import { renderTemplate } from "@/modules/messaging/templates";
import {
  childByKey,
  familyByKey,
  runOfChild,
  stopByKey,
  VEHICLES,
  type Child,
} from "./fixtures/standard";

/** Why the keyword parser answered when the vendor was configured and reachable. */
export const EVERY_MODEL_FAILED = "every configured model failed, so the keyword reader answered";

/** The tenant every fixture token belongs to (ADR-000 #5: one site in P1). */
const SITE_TOKEN = "S1";

/** Fixture-shaped tokens, the same ones the slice-1/2 suites use: readable, and not uuids. */
const legToken = (childKey: string, direction: "AM" | "PM") => `L-${childKey}-${direction}`;
const threadToken = (familyKey: string) => `T-${familyKey}`;
const messageToken = (familyKey: string) => `M-${familyKey}-1`;

export type TurnSource = "model" | "keyword";

/** What a staff-typed text produced: who answered, what they chose, and what §11.2 said about it. */
export type DemoAgentTurn = {
  readonly source: TurnSource;
  /** The configured model id when a model answered; null on the degraded path. */
  readonly model: string | null;
  /** Why the keyword parser answered instead, in the refusal's own words. Null on the live path. */
  readonly degradedReason: string | null;
  readonly tool: string;
  readonly verdict: PolicyDecision["verdict"];
  /** The §11.2 rule behind a proposal or a block. */
  readonly rule: string | null;
  /** The sanitized arguments, as the policy engine would store them. */
  readonly args: Record<string, unknown>;
  /** What a human signature would be bound to (`approvalKey`), so approving is exact. */
  readonly approvalKey: string;
  /** True for a human-tier call: it mutated nothing and sent nothing (§11.2). */
  readonly mutated: boolean;
  /** The change the proposal is about, when the text asked for a different drop-off. */
  readonly dropoff: DropoffRequest | null;
};

/** The drop-off a parent asked for, read from their own words. */
export type DropoffRequest = {
  readonly childKey: string;
  /** "17:00" — the time the text asks for, site-local. */
  readonly requestedHhmm: string;
  /** The planned window the family currently holds for that ride. */
  readonly plannedWindowText: string | null;
};

/**
 * The time a parent's text asks for, in whole hours and minutes.
 *
 * Deliberately small and deliberately **not** the model's job: the catalog has no tool that
 * carries a new drop-off time (§11.2 gives the agent a *change request*, not a plan edit), so the
 * time a coordinator is about to approve has to be read off the request itself and shown to them.
 * It reads "at 5", "at 5pm", "5:15", "17:00" and nothing cleverer; a text it cannot read asks for
 * no particular time, and the proposal says so rather than inventing one.
 */
export function requestedTime(text: string): string | null {
  const m = /\b(?:at\s+)?([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/i.exec(text.replace(/\$\d+/g, ""));
  if (!m) return null;
  const minutes = m[2] ?? "00";
  let hours = Number(m[1]);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  // No meridiem on a small hour: a family asking about a *drop-off* means the afternoon.
  if (!meridiem && hours < 7) hours += 12;
  return `${String(hours).padStart(2, "0")}:${minutes}`;
}

/** Words that make a text a request to change where or when a child is set down. */
const DROPOFF_REQUEST = /\b(?:drop|dropped|drop-?off|collect|pick ?up|grandma|grandmother|grandpa|aunt|uncle|home)\b/i;

export function dropoffRequestIn(childKey: string, text: string, day: ServiceDay): DropoffRequest | null {
  if (!DROPOFF_REQUEST.test(text)) return null;
  const requestedHhmm = requestedTime(text);
  if (!requestedHhmm) return null;
  const child = childByKey(childKey);
  const run = runOfChild(childKey);
  return {
    childKey,
    requestedHhmm,
    plannedWindowText: run ? plannedWindowFor(child, run, "PM", day) : null,
  };
}

/* ───────────────────────────── the turn ───────────────────────────── */

export type TurnInput = {
  readonly childKey: string;
  /** What a staff member typed on the panel, as the parent would have sent it. */
  readonly text: string;
  readonly day: ServiceDay;
  readonly env?: Record<string, string | undefined>;
  readonly now?: Date;
  /** A provider to drive instead of the configured one. Tests only; production passes none. */
  readonly provider?: Parameters<typeof createGateway>[0];
};

/**
 * Run one turn: assemble, call, judge.
 *
 * A gateway refusal is not an exception here — a model that answers with prose, with two calls or
 * with a tool outside the catalog is a *result* a coordinator should see, so it comes back as a
 * blocked turn naming the outcome rather than as a stack trace.
 */
export async function demoAgentTurn(input: TurnInput): Promise<DemoAgentTurn> {
  const env = input.env ?? process.env;
  const config = loadAgentConfig(env);
  const choice = input.provider
    ? { provider: input.provider, degraded: false, reason: null }
    : chooseProvider(config, env);
  const gateway = createGateway(choice.provider, config);

  const child = childByKey(input.childKey);
  const family = familyByKey(child.familyKey);
  const runId = `demo-${child.key}`;
  const text = tokenizeNames(input.text).slice(0, 600);
  const facts = tierFactsFor(child, text, input.day);
  const trigger = { type: "msg.inbound" as const, id: messageToken(family.key), siteId: SITE_TOKEN };
  const prompt = tierPrompt(facts, { runId, trigger, committed: [], now: input.now ?? new Date() });

  /**
   * The adapter has a fallback of its own — primary model, backup model, then the keyword parser
   * (providers/remote.ts) — so "a model answered" cannot be decided before the call. The attempts
   * it records are read afterwards: a turn where every attempt failed was answered by the parser,
   * whatever the wiring said, and the card must say so. The alternative is a screen that calls a
   * rate-limited fallback a model answer, which is the one dishonest thing it could do.
   */
  const remote = "attempts" in choice.provider ? (choice.provider as { attempts: readonly { ok: boolean }[] }) : null;
  const attemptsBefore = remote?.attempts.length ?? 0;
  const fellBack = () => {
    const made = remote?.attempts.slice(attemptsBefore) ?? [];
    return made.length > 0 && made.every((a) => !a.ok);
  };

  const dropoff = dropoffRequestIn(child.key, input.text, input.day);
  const answeredBy = (): { source: TurnSource; model: string | null; degradedReason: string | null } =>
    choice.degraded || fellBack()
      ? {
          source: "keyword",
          model: null,
          degradedReason: choice.reason ?? EVERY_MODEL_FAILED,
        }
      : { source: "model", model: config.model, degradedReason: null };

  let call;
  try {
    const result = await gateway.complete({ runId, prompt });
    call = result.call;
  } catch (e) {
    // The gateway refused the turn (prose, two calls, an unknown tool, a rate limit that reached
    // here). Named, and nothing executed.
    const outcome = e instanceof GatewayError ? e.outcome : "REJECTED_SCHEMA";
    return {
      ...answeredBy(),
      dropoff,
      tool: "",
      verdict: "BLOCK",
      rule: outcome,
      args: {},
      approvalKey: "",
      mutated: false,
    };
  }

  const decision = evaluate(call, {
    scope: scopeFor(child),
    sendableSubjects: new Set([child.key, threadToken(family.key)]),
    untrustedMessages: facts.t3,
    paused: false,
    sourceMessageId: messageToken(family.key),
  });

  return {
    ...answeredBy(),
    dropoff,
    tool: call.tool,
    verdict: decision.verdict,
    rule: decision.verdict === "ALLOW" ? null : decision.rule,
    args: decision.verdict === "BLOCK" ? {} : decision.args,
    approvalKey: decision.verdict === "BLOCK" ? "" : approvalKey(call.tool, decision.args),
    mutated: decision.verdict === "ALLOW" && call.tier !== "human",
  };
}

/** This family's objects, as a session would build the scope — never from a tool argument. */
function scopeFor(child: Child) {
  return familyScope(
    child.familyKey,
    [child.key, legToken(child.key, "AM"), legToken(child.key, "PM"), threadToken(child.familyKey), messageToken(child.familyKey)],
    [],
    SITE_TOKEN,
  );
}

/** The four tiers over the fixtures: tokens, codes and versions, exactly as the DB assembler's. */
function tierFactsFor(child: Child, tokenizedText: string, day: ServiceDay) {
  const run = runOfChild(child.key);
  return {
    t1: [
      `site=${SITE_TOKEN}`,
      `family=${child.familyKey}`,
      `children=${child.key}`,
      `profile child=${child.key} version=1 needs=${child.needs.filter((n) => n.state === "APPROVED").map((n) => n.category).join("|") || "none"}`,
      `contact_scopes=${child.scopes.join(",")}`,
    ].join(" "),
    t2: [
      `service_date=${day.iso}`,
      `thread=${threadToken(child.familyKey)} state=OPEN`,
      `leg=${legToken(child.key, "AM")} child=${child.key} part=AM state=SCHEDULED version=1`,
      `leg=${legToken(child.key, "PM")} child=${child.key} part=PM state=SCHEDULED version=1 window=${child.pmWindow}${
        run ? ` vehicle=${run.vehicleKey}` : ""
      }`,
    ].join(" "),
    t3: [tokenizedText],
    t4: "channel=SMS_1TO1",
  };
}

/* ───────────────────────────── approving one ───────────────────────────── */

/** What approving a proposed drop-off change does: the ride moves, and the family is told. */
export type ApprovedDropoff = {
  readonly childKey: string;
  readonly childLabel: string;
  readonly childFirstName: string;
  /** The window the family held before, and the one they hold now. */
  readonly beforeWindowText: string | null;
  readonly afterWindowText: string;
  readonly place: string;
  readonly vanLabel: string | null;
  /** The templated confirmation, rendered by the outbox's own renderer. */
  readonly reply: { readonly templateId: string; readonly vars: Record<string, string>; readonly body: string };
};

/**
 * Apply an approved drop-off change, as the demo shows it.
 *
 * Two §11.2 rules meet here and the screen says both out loud:
 *  - the **change** needed a person. A `propose_*` call mutates nothing; a coordinator's approval
 *    is what releases it, bound to that exact call (`approvalKey`).
 *  - the **reply** did not. It is an allow-listed template with code-shaped vars, so it goes on
 *    the agent's own authority (§11.2 marks every sending tool `auto`) — the one thing that still
 *    needs a human is free text to a parent, and there is none here: the words are the outbox's.
 */
export function approveDropoff(request: DropoffRequest, day: ServiceDay): ApprovedDropoff {
  const child = childByKey(request.childKey);
  const run = runOfChild(request.childKey);
  const atMs = localTimeOn(day, request.requestedHhmm);
  const window = windowFor(atMs);
  const stop = child.stopKey ? stopByKey(child.stopKey) : null;
  const vars = {
    legDate: day.iso,
    eta: formatClock24(window.startMs),
    etaEnd: formatClock24(window.endMs),
    stopLabel: stop?.smsToken ?? "CENTER",
  };
  const templateId = "dropoff.changed";
  const vehicle = VEHICLES.find((v) => v.key === run?.vehicleKey);
  return {
    childKey: child.key,
    childLabel: child.label,
    childFirstName: child.firstName,
    beforeWindowText: request.plannedWindowText,
    // The window as a person reads it ("5:00–5:10 PM"); the 24-hour form is only ever a var.
    afterWindowText: formatWindow(window.startMs, window.endMs),
    place: stop?.label ?? "",
    vanLabel: vehicle?.label ?? null,
    reply: { templateId, vars, body: renderTemplate(templateId, vars) },
  };
}
