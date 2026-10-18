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
 *    inside the adapter and never seen here (`chooseProvider` → `providers/remote.ts`). There is
 *    no second reader behind it: the founder's rule of 2026-10-17 deleted the PRD §18.1 keyword
 *    parser, so a deployment with no key, or a chain where every model failed, produces **no
 *    turn at all** — `modelUnavailable`, which the screen renders as the "needs a person" staff
 *    alert and never as a proposal card;
 *  - the **gateway** is the real one, so the prompt is validated token-only, the response must be
 *    exactly one schema-valid catalog tool call, and the audit row carries hashes only;
 *  - the **policy engine** is the real one, so what comes back is §11.2's verdict — and a
 *    `human`-tier call is a PROPOSAL that mutates nothing and sends nothing until a person signs
 *    the exact call (`approvalKey`).
 *
 * What is *not* here: any write, and **anything that reads the family's words**. The drop-off a
 * turn comes back with is read off the model's own `propose_dropoff_change` arguments — a
 * schema-validated time and a stop token off the centre's list — and never out of the parent's
 * sentence. This module used to carry a `requestedTime` regex and a keyword list of drop-off
 * words; both are deleted, and `agent/no-keyword-fallback.test.ts` is the gate that keeps them
 * out. A text the model does not turn into a tool call asks for nothing in particular, and the
 * screen says so rather than guessing a time out of it.
 *
 * Applying a turn is `approveDropoff` below, which computes what the change would be and renders
 * the templated confirmation the family would get — the same template, through the same
 * renderer, as every other outbound text.
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
  STOPS,
  stopByKey,
  VEHICLES,
  type Child,
} from "./fixtures/standard";

/** Why no model answered although the vendor was configured and reachable. */
export const EVERY_MODEL_FAILED = "every configured model failed, so no model answered";

/** The tenant every fixture token belongs to (ADR-000 #5: one site in P1). */
const SITE_TOKEN = "S1";

/** Fixture-shaped tokens, the same ones the slice-1/2 suites use: readable, and not uuids. */
const legToken = (childKey: string, direction: "AM" | "PM") => `L-${childKey}-${direction}`;
const threadToken = (familyKey: string) => `T-${familyKey}`;
const messageToken = (familyKey: string) => `M-${familyKey}-1`;

/** The one tool whose arguments carry a proposed drop-off (`agent/tools.ts`). */
const DROPOFF_CHANGE_TOOL = "propose_dropoff_change";

/** What a staff-typed text produced: whether a model answered, what it chose, and §11.2's verdict. */
export type DemoAgentTurn = {
  /**
   * True when **no model answered**: no key, an unconfirmed demo-data deployment, or a chain
   * where every attempt failed. There is nothing behind a model any more (founder, 2026-10-17),
   * so this is not a degraded answer — it is the absence of one. Nothing is proposed, no card
   * renders, and the screen shows the "needs a person" alert instead.
   */
  readonly modelUnavailable: boolean;
  /** The configured model id when a model answered; null when none did. */
  readonly model: string | null;
  /**
   * Why no model answered, in the refusal's own words — the name of an environment variable,
   * never a value. For the server record; the sentences a coordinator reads live in `ui/copy.ts`.
   */
  readonly unavailableReason: string | null;
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

/**
 * The drop-off the **model** proposed, off its own `propose_dropoff_change` arguments.
 *
 * Not read from the parent's sentence, and that is the point: a requested time is a field of a
 * schema-validated tool call or it does not exist (founder, 2026-10-17). A model that cannot say
 * which minute it means has not understood the text, and the right answer to that is a person.
 */
export type DropoffRequest = {
  readonly childKey: string;
  /** "17:00" — the time the model proposed, site-local. Null when only the place moved. */
  readonly requestedHhmm: string | null;
  /** The centre's own stop token the model proposed. Null when only the time moved. */
  readonly requestedStopToken: string | null;
  /** The planned window the family currently holds for that ride. */
  readonly plannedWindowText: string | null;
};

/**
 * The drop-off a `propose_dropoff_change` call is asking for.
 *
 * Reads the **policy engine's sanitized arguments** and nothing else — `requested_dropoff_time`
 * is a 24-hour clock value the tool's schema already validated, and `requested_stop_token` is one
 * of the centre's own stops (`KNOWN_STOP_TOKENS`). Any other tool, or a blocked call, proposes no
 * drop-off: this returns null rather than looking at what the family typed.
 */
export function dropoffFromCall(
  childKey: string,
  tool: string,
  args: Record<string, unknown>,
  day: ServiceDay,
): DropoffRequest | null {
  if (tool !== DROPOFF_CHANGE_TOOL) return null;
  const requestedHhmm = typeof args.requested_dropoff_time === "string" ? args.requested_dropoff_time : null;
  const requestedStopToken = typeof args.requested_stop_token === "string" ? args.requested_stop_token : null;
  if (requestedHhmm === null && requestedStopToken === null) return null;
  const child = childByKey(childKey);
  const run = runOfChild(childKey);
  return {
    childKey,
    requestedHhmm,
    requestedStopToken,
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
    ? { provider: input.provider, refused: false, reason: null }
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
   * Whether a model actually answered cannot be decided before the call. The adapter tries the
   * primary model and then the backup, and the chain ends in a **refusal** rather than in a
   * second kind of reader (founder, 2026-10-17), so a turn whose every attempt failed is a turn
   * no model answered — whatever the wiring said. The attempts it records are read afterwards;
   * the alternative is a screen that calls a rate-limited chain a model answer, which is the one
   * dishonest thing it could do.
   */
  const remote = "attempts" in choice.provider ? (choice.provider as { attempts: readonly { ok: boolean }[] }) : null;
  const attemptsBefore = remote?.attempts.length ?? 0;
  const everyAttemptFailed = () => {
    const made = remote?.attempts.slice(attemptsBefore) ?? [];
    return made.length > 0 && made.every((a) => !a.ok);
  };

  const answeredBy = (): Pick<DemoAgentTurn, "modelUnavailable" | "model" | "unavailableReason"> =>
    choice.refused || everyAttemptFailed()
      ? {
          modelUnavailable: true,
          model: null,
          unavailableReason: choice.reason ?? EVERY_MODEL_FAILED,
        }
      : { modelUnavailable: false, model: config.model, unavailableReason: null };

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
      // Nothing was proposed, so there is no drop-off to show. A refused turn never carries one:
      // the only source of a requested time is a tool call that came back and was allowed.
      dropoff: null,
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

  const args = decision.verdict === "BLOCK" ? {} : decision.args;
  return {
    ...answeredBy(),
    // Off the model's own arguments, after the policy engine has sanitized them — never off the
    // family's sentence, and never at all for a call the engine blocked.
    dropoff: dropoffFromCall(child.key, call.tool, args, input.day),
    tool: call.tool,
    verdict: decision.verdict,
    rule: decision.verdict === "ALLOW" ? null : decision.rule,
    args,
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
  // A proposal may move the time, the place, or both. When only the place moved the ride keeps
  // the window the family already holds, rather than being handed a time nobody proposed.
  const atMs = localTimeOn(day, request.requestedHhmm ?? child.pmWindow);
  const window = windowFor(atMs);
  const stopKey = request.requestedStopToken
    ? STOPS.find((s) => s.smsToken === request.requestedStopToken)?.key ?? child.stopKey
    : child.stopKey;
  const stop = stopKey ? stopByKey(stopKey) : null;
  /*
   * No `etaEnd`: an approved drop-off is a decided minute and not a window any more (Firia,
   * 2026-10-17 10:51 PM ET), and `dropoff.changed`'s allowlist no longer permits one.
   */
  const vars = {
    legDate: day.iso,
    eta: formatClock24(window.startMs),
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
    reply: { templateId, vars, body: renderTemplate(templateId, vars, { child: child.firstName }) },
  };
}
