/**
 * WHAT A CARD RUNS, AND THE TOOLS A TEAMMATE IS HANDED (ledger #74, #77).
 *
 * `ACTION_TOOLS` are what Approve runs on a confirm card: one per registry action, kept under the
 * names cards already carry. They are not offered to the model any more. `TEAM_TOOLS` are: shaped
 * like the screens a coordinator uses, every change a card a person approves (ledger #77).
 *
 * The card runners, one per action a person can take in the UI (ledger #74):
 *
 * Each tool here is a registry action (`modules/actions/registry.ts`) under the names the catalog
 * allows — no argument may name a site, a role, an approval or a recipient (`FORBIDDEN_ARG_TOKENS`),
 * so `approvalId` is `card_id` here and the site is never an argument: it is the run's own. `action`
 * says which registry entry the tool runs, and `toInput` turns the model's arguments into that
 * entry's input. The executor (`run/exec/actions.ts`) runs it as the person who asked, through
 * `authorize` and the entry's own function — the one the screen runs.
 *
 * Kept free of the registry's imports on purpose: the catalog (tools.ts) is read on paths that must
 * not pull the plan writers or the demo seed into their graph.
 *
 * Tier follows the registry's `confirm`: an action PRD §11.2 forbids the agent to take on its own is
 * `human`, so the policy engine makes it a PROPOSAL — a card a person presses — and nothing runs.
 */
import { z } from "zod";
import { agentGuidance } from "@/ui/copy";
import { API } from "@/auth/access";
import { VANS, vanNameOf } from "@/config/vans";
import type { ToolDef } from "./tools";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LEG = z.enum(["AM", "PM"]);
const ID = z.string().min(1).max(64);
const BUCKET = z.enum(["VAN", "UNASSIGNED", "FAMILY_DRIVES", "ABSENT"]);
const COUNT = z.number().int().min(0).max(20);

/** The board's version is read when the action runs, never taken from the model (it would be stale). */
export type BoardVersionLookup = (date: string, leg: "AM" | "PM") => Promise<number>;

export type ActionTool = ToolDef & {
  /** The registry entry this tool runs. */
  readonly action: string;
  /** That entry's row in the access table — who may press the card (parity.test.ts holds them equal). */
  readonly endpoint: string;
  /** The model's arguments as that entry's input. Reads the board's current version where it needs one. */
  readonly toInput: (args: Record<string, unknown>, version: BoardVersionLookup) => Promise<unknown>;
};

const move = z.object({ child_token: ID, bucket: BUCKET, van_id: ID.nullable().optional(), not_before: z.string().optional() });
const asMove = (m: z.infer<typeof move>) => ({
  childToken: m.child_token,
  bucket: m.bucket,
  vanId: m.bucket === "VAN" ? (m.van_id ?? null) : null,
  // A time agreed with the family travels with the move (ledger #79).
  ...(m.not_before ? { notBefore: m.not_before } : {}),
});

/**
 * WHAT THE CARD SAYS, in the model's words (ledger #75 c). Any action may carry a `note`: when the
 * action becomes a card for a person (a `human` tool, or any tool in an alert's run), the note is
 * the card's sentence — "Van 1 came back with one seat, so Ava N. moves to Van 3, about 10 min
 * later" — rather than a line this app assembled about the tool. Staff prose: the same bound as
 * every other prose field (tools.ts `staffProse`), redacted by the policy engine before it is kept,
 * and never an input to the action itself.
 */
const NOTE = z.string().min(1).max(600).optional();

const tool = (t: Omit<ActionTool, "staffTextFields" | "sendCopy">): ActionTool => ({
  ...t,
  schema: t.schema.extend({ note: NOTE }),
  staffTextFields: ["note"],
  sendCopy: null,
});

export const ACTION_TOOLS: readonly ActionTool[] = [
  tool({
    name: "auto_plan",
    action: "auto_plan",
    endpoint: API.planReplan,
    tier: "auto",
    effect: "mutate",
    schema: z.object({ date: DATE, leg: LEG }),
    prd: "ledger #74, #76: Re-plan as a draft card the person approves — the ramp's Re-plan",
    description: agentGuidance.autoPlan,
    toInput: async (a) => ({ date: a.date, direction: a.leg, note: typeof a.note === "string" ? a.note : null }),
  }),
  tool({
    name: "move_child",
    action: "move_child",
    endpoint: API.planSave,
    tier: "auto",
    effect: "mutate",
    schema: z.object({ date: DATE, leg: LEG }).merge(move),
    prd: "ledger #74: one drag + Save on the plan board",
    description: agentGuidance.moveChild,
    toInput: async (a) => ({
      date: a.date,
      direction: a.leg,
      ...asMove(a as z.infer<typeof move>),
      // The board the card was drafted on (PPE-110), as `save_plan` below.
      ...(typeof a.basis_version === "number" ? { version: a.basis_version } : {}),
    }),
  }),
  tool({
    name: "save_plan",
    action: "save_plan",
    endpoint: API.planSave,
    tier: "auto",
    effect: "mutate",
    schema: z.object({ date: DATE, leg: LEG, moves: z.array(move).max(40) }),
    prd: "ledger #74: several moves and one Save on the plan board",
    description: agentGuidance.savePlan,
    toInput: async (a, version) => ({
      date: a.date,
      direction: a.leg,
      // The board the card was drafted on, when it says (ledger #86): a plan saved past it since is
      // the board's own CHANGED, never a re-plan written over somebody's newer save.
      version: typeof a.basis_version === "number" ? a.basis_version : await version(String(a.date), a.leg as "AM" | "PM"),
      moves: (a.moves as z.infer<typeof move>[]).map(asMove),
      // A plan card may also move departures (ledger #77): by van id, "HH:MM", as the board saves them.
      ...(a.departures && typeof a.departures === "object" ? { departures: a.departures } : {}),
    }),
  }),
  tool({
    name: "confirm_van_setup",
    action: "confirm_van_setup",
    endpoint: API.vanSetup,
    tier: "auto",
    effect: "mutate",
    schema: z.object({
      date: DATE,
      van_id: ID,
      seats: COUNT,
      wheelchair_spots: COUNT,
      car_seats: COUNT,
      oxygen_mounts: COUNT,
      has_lift: z.boolean(),
    }),
    prd: "ledger #74: a van's counts as the ramp found them",
    description: agentGuidance.confirmVan,
    toInput: async (a) => ({
      vanId: a.van_id,
      date: a.date,
      seats: a.seats,
      wheelchairSpots: a.wheelchair_spots,
      carSeats: a.car_seats,
      oxygenMounts: a.oxygen_mounts,
      hasLift: a.has_lift,
      state: "CHECKED",
    }),
  }),
  tool({
    name: "set_child_needs",
    action: "set_child_needs",
    endpoint: API.childNeeds,
    tier: "human",
    effect: "propose",
    schema: z.object({ date: DATE, leg: LEG, child_token: ID, wheelchair: z.boolean(), car_seat: z.boolean(), oxygen: z.boolean() }),
    prd: "ledger #74 (d): editing approved needs is PRD §11.2-prohibited — a confirm card",
    description: agentGuidance.setNeeds,
    toInput: async (a, version) => ({
      childToken: a.child_token,
      date: a.date,
      direction: a.leg,
      wheelchair: a.wheelchair,
      carSeat: a.car_seat,
      oxygen: a.oxygen,
      version: await version(String(a.date), a.leg as "AM" | "PM"),
    }),
  }),
  tool({
    name: "restart_demo_day",
    action: "restart_demo_day",
    endpoint: API.demoReset,
    tier: "human",
    effect: "propose",
    schema: z.object({}),
    prd: "ledger #74 (d): Restart is the director's — a confirm card",
    description: agentGuidance.restart,
    toInput: async () => ({}),
  }),
  tool({
    name: "decide_card",
    action: "decide_approval",
    endpoint: "action:approval-decision",
    tier: "human",
    effect: "propose",
    schema: z.object({ card_id: ID, decision: z.enum(["APPROVED", "DECLINED"]), edited_text: z.string().min(1).max(600).optional() }),
    prd: "ledger #74 (d): deciding a card is PRD §11.2-prohibited (overriding approvals) — a confirm card",
    description: agentGuidance.decideCard,
    toInput: async (a) => ({ approvalId: a.card_id, decision: a.decision, editedText: a.edited_text ?? null }),
  }),
  tool({
    name: "take_alert",
    action: "take_alert",
    endpoint: "action:approval-decision",
    tier: "auto",
    effect: "mutate",
    schema: z.object({ alert_id: ID }),
    prd: "ledger #74: the Take button on a needs-a-person alert",
    description: agentGuidance.takeAlert,
    toInput: async (a) => ({ alertId: a.alert ?? a.alert_id }),
  }),
];


/* ─────────────────────────── the teammate's tools (ledger #77) ─────────────────────────── */

/**
 * WHAT A TEAMMATE IS HANDED: the screens' reads, one way to change the plan, a card for every other
 * change, Take, and the answer. Shaped the way a coordinator talks — "Van 2", "the afternoon", "C6"
 * — so there is no id, version or date for the model to get wrong: the date is always the run's
 * today, a van is its name, a child is the prompt's token, a card or an alert its prompt label.
 *
 * Every change is a card (`human` tier: the policy engine makes it a PROPOSAL and a person's
 * Approve runs the card's action through the registry). The writers are `run/exec/proposals.ts`;
 * the reads are `run/exec/actions.ts`.
 */
const VAN_NAMES = VANS.map((v) => vanNameOf(v.slot)) as [string, ...string[]];
const VAN = z.enum(VAN_NAMES);
const CHILD = z.string().min(1).max(64).describe("the child's token from the prompt, e.g. C6");
const PLACE = z.enum([...VAN_NAMES, "UNASSIGNED", "FAMILY_DRIVES", "ABSENT"]);
const CLOCK = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe("24-hour site time, e.g. 15:30");
export const TEAM_MOVE = z.object({ child: CHILD, place: PLACE });
export const TEAM_DEPARTURE = z.object({ van: VAN, leaves: CLOCK });
const NOTE_REQUIRED = z.string().min(1).max(600).describe(agentGuidance.cardNote);

const read = (name: string, schema: z.ZodObject, description: string, prd: string): ToolDef => ({
  name, tier: "auto", effect: "read", schema, staffTextFields: [], sendCopy: null, prd, description,
});
const card = (name: string, schema: z.ZodObject, description: string, prd: string): ToolDef => ({
  name, tier: "human", effect: "propose", schema: schema.extend({ note: NOTE_REQUIRED }), staffTextFields: ["note"], sendCopy: null, prd, description,
});

export const TEAM_TOOLS: readonly ToolDef[] = [
  read("get_activity", z.object({}), agentGuidance.getActivity, "ledger #76: what happened today, read-only"),
  read(
    "get_plan",
    z.object({
      leg: LEG,
      preview: z.object({ moves: z.array(TEAM_MOVE).max(40).optional(), departures: z.array(TEAM_DEPARTURE).max(VANS.length).optional() }).optional(),
    }),
    agentGuidance.getPlan,
    "ledger #74, #77: the plan board as the person sees it, and a change previewed before it is proposed",
  ),
  read("get_child", z.object({ child: CHILD }), agentGuidance.getChild, "ledger #77: one child's day, both legs, as their card shows it"),
  read("get_waiting", z.object({}), agentGuidance.getWaiting, "ledger #77: the cards and alerts waiting for a person"),
  read("read_family_texts", z.object({ child: CHILD }), agentGuidance.readFamilyTexts, "ledger #77: a family's recent texts, as evidence"),
  card(
    "propose_plan_change",
    z.object({
      leg: LEG,
      replan: z.boolean().optional().describe(agentGuidance.replanArg),
      moves: z.array(TEAM_MOVE).max(40).optional(),
      departures: z.array(TEAM_DEPARTURE).max(VANS.length).optional(),
    }),
    agentGuidance.proposePlanChange,
    "ledger #76, #77: the one way the agent changes a plan — a card whose Approve is the board's Save",
  ),
  card(
    "propose_van_setup",
    z.object({ van: VAN, seats: COUNT, wheelchair_spots: COUNT, car_seats: COUNT, oxygen_mounts: COUNT, has_lift: z.boolean() }),
    agentGuidance.proposeVanSetup,
    "ledger #77: a van's counts as the ramp found them — a card",
  ),
  card(
    "propose_needs_change",
    z.object({ child: CHILD, leg: LEG, wheelchair: z.boolean(), car_seat: z.boolean(), oxygen: z.boolean() }),
    agentGuidance.setNeeds,
    "ledger #74 (d): editing approved needs is PRD §11.2-prohibited — a card",
  ),
  card(
    "propose_card_decision",
    z.object({ card: ID.describe("the card's label from get_waiting, e.g. CARD-1"), decision: z.enum(["APPROVED", "DECLINED"]), edited_text: z.string().min(1).max(600).optional() }),
    agentGuidance.decideCard,
    "ledger #74 (d): deciding a card is PRD §11.2-prohibited (overriding approvals) — a card",
  ),
  card("restart_demo_day", z.object({}), agentGuidance.restart, "ledger #74 (d): Restart is the director's — a card"),
  {
    name: "take_alert",
    tier: "auto",
    effect: "mutate",
    schema: z.object({ alert: ID.describe("the alert's label, e.g. TK-1") }),
    staffTextFields: [],
    sendCopy: null,
    prd: "ledger #74: the Take button on a needs-a-person alert",
    description: agentGuidance.takeAlert,
  },
];

/** Tools only a staff member's or an alert's run is offered: never a family's text (assembler.ts). */
export const STAFF_ONLY_TOOLS: ReadonlySet<string> = new Set(TEAM_TOOLS.map((t) => t.name));

/** Which teammate tool takes each registry action — the parity test's other half. */
export const TOOL_FOR_ACTION: Readonly<Record<string, string>> = {
  save_plan: "propose_plan_change",
  auto_plan: "propose_plan_change",
  move_child: "propose_plan_change",
  place_child: "propose_plan_change",
  confirm_van_setup: "propose_van_setup",
  set_child_needs: "propose_needs_change",
  decide_approval: "propose_card_decision",
  restart_demo_day: "restart_demo_day",
  take_alert: "take_alert",
};

/** The card runner behind a confirm card's `tool` (confirm.ts). */
export function actionTool(name: string): ActionTool | undefined {
  return ACTION_TOOLS.find((t) => t.name === name);
}
