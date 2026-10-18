/**
 * The child panel's Save, on a server with no database: an override of the fixture's own needs,
 * in this process's memory.
 *
 * The same shape of thing as src/modules/plan/memory.ts and for the same one reason: `pnpm e2e`
 * builds the app and starts it with **no `DATABASE_URL`** (playwright.config.ts), and the walk
 * the demo is gated on — open a child, turn Oxygen on, Save, watch the plan move — has to be
 * walkable there. With a database, the panel writes `ops.transport_need_item` instead
 * (src/modules/roster/needs-write.ts), which is what every deployment does.
 *
 * It **fails closed** exactly like the plan store: asking for it while a database URL is set
 * throws, so a deployment can never keep a child's needs in one serverless instance's memory.
 *
 * State hangs off `globalThis` because Next bundles a route handler and a server component
 * separately: a module-level `const` would be two objects, and a Save would vanish on the next
 * render (src/modules/plan/memory.ts says the same thing at more length).
 */
import type { PanelNeeds } from "@/domain/plan/needs";

export const NEEDS_OVERRIDE_REFUSED =
  "the in-memory needs override cannot be used when a database is configured";

const KEY = "__ppecDemoNeedsOverride";
type Holder = typeof globalThis & { [KEY]?: Map<string, PanelNeeds> };

function state(): Map<string, PanelNeeds> {
  const holder = globalThis as Holder;
  holder[KEY] ??= new Map<string, PanelNeeds>();
  return holder[KEY];
}

/** What the panel last saved for this child here, or null for "the fixture's own answer". */
export function demoNeedsOverride(childToken: string): PanelNeeds | null {
  return state().get(childToken) ?? null;
}

/** Keep what the panel saved. Refused outright when a database is configured. */
export function setDemoNeedsOverride(
  childToken: string,
  panel: PanelNeeds,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.DATABASE_URL) throw new Error(NEEDS_OVERRIDE_REFUSED);
  state().set(childToken, panel);
}

/** Forget everything: the demo reset, and any test that wants a fresh process. */
export function clearDemoNeedsOverride(): void {
  state().clear();
}
