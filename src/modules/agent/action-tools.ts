/**
 * THE AGENT'S HANDS: one tool per action a person can take in the UI (ledger #74).
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
  /** The model's arguments as that entry's input. Reads the board's current version where it needs one. */
  readonly toInput: (args: Record<string, unknown>, version: BoardVersionLookup) => Promise<unknown>;
};

const move = z.object({ child_token: ID, bucket: BUCKET, van_id: ID.nullable().optional() });
const asMove = (m: z.infer<typeof move>) => ({
  childToken: m.child_token,
  bucket: m.bucket,
  vanId: m.bucket === "VAN" ? (m.van_id ?? null) : null,
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
    tier: "auto",
    effect: "mutate",
    schema: z.object({ date: DATE, leg: LEG }),
    prd: "ledger #74: the board's Auto-plan + Save, as the person who asked",
    description: agentGuidance.autoPlan,
    toInput: async (a) => ({ date: a.date, direction: a.leg }),
  }),
  tool({
    name: "move_child",
    action: "move_child",
    tier: "auto",
    effect: "mutate",
    schema: z.object({ date: DATE, leg: LEG }).merge(move),
    prd: "ledger #74: one drag + Save on the plan board",
    description: agentGuidance.moveChild,
    toInput: async (a) => ({ date: a.date, direction: a.leg, ...asMove(a as z.infer<typeof move>) }),
  }),
  tool({
    name: "save_plan",
    action: "save_plan",
    tier: "auto",
    effect: "mutate",
    schema: z.object({ date: DATE, leg: LEG, moves: z.array(move).min(1).max(40) }),
    prd: "ledger #74: several moves and one Save on the plan board",
    description: agentGuidance.savePlan,
    toInput: async (a, version) => ({
      date: a.date,
      direction: a.leg,
      version: await version(String(a.date), a.leg as "AM" | "PM"),
      moves: (a.moves as z.infer<typeof move>[]).map(asMove),
    }),
  }),
  tool({
    name: "confirm_van_setup",
    action: "confirm_van_setup",
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
    tier: "auto",
    effect: "mutate",
    schema: z.object({ alert_id: ID }),
    prd: "ledger #74: the Take button on a needs-a-person alert",
    description: agentGuidance.takeAlert,
    toInput: async (a) => ({ alertId: a.alert_id }),
  }),
];

/**
 * What the agent reads so it sees what the person sees. Answers come back as prompt facts; nothing
 * is written. `read` effect, so they still answer while the agent is paused.
 */
export const STAFF_READ_TOOLS: readonly ToolDef[] = [
  {
    name: "get_plan",
    tier: "auto",
    effect: "read",
    schema: z.object({ date: DATE, leg: LEG }),
    staffTextFields: [],
    sendCopy: null,
    prd: "ledger #74: the plan board as the person sees it",
    description: agentGuidance.getPlan,
  },
  {
    name: "get_alerts",
    tier: "auto",
    effect: "read",
    schema: z.object({}),
    staffTextFields: [],
    sendCopy: null,
    prd: "ledger #74: the open alerts a coordinator sees",
    description: agentGuidance.getAlerts,
  },
  {
    name: "get_cards",
    tier: "auto",
    effect: "read",
    schema: z.object({}),
    staffTextFields: [],
    sendCopy: null,
    prd: "ledger #74: the cards waiting for a person",
    description: agentGuidance.getCards,
  },
];

/** Tools only a staff member's run is offered: never a family's text (assembler.ts). */
export const STAFF_ONLY_TOOLS: ReadonlySet<string> = new Set([
  ...ACTION_TOOLS.map((t) => t.name),
  ...STAFF_READ_TOOLS.map((t) => t.name),
]);

/** Which agent tool takes each registry action — the parity test's other half. */
export const TOOL_FOR_ACTION: Readonly<Record<string, string>> = {
  ...Object.fromEntries(ACTION_TOOLS.map((t) => [t.action, t.name])),
  // The single-move endpoint is the same act as a drag and a Save.
  place_child: "move_child",
};

export function actionTool(name: string): ActionTool | undefined {
  return ACTION_TOOLS.find((t) => t.name === name);
}
