/**
 * The machine-readable half of a demo-reset refusal.
 *
 * One refusal is not a failure: on a preview deployment the database is production's, served
 * read-only (DECISION-LEDGER #43), so `POST /api/demo/reset` refuses there **by design** —
 * `demoControlsGate` in ./reset.ts, checked ahead of every other gate. The header's control has
 * to tell that apart from a reset that really went wrong, because the two have different
 * answers: on the by-design refusal the scenario clock starts anyway and one line says so, and
 * on a failure nothing starts (founder's final ruling, 2026-10-17 14:44 ET, ledger row 88).
 *
 * A status code cannot carry that distinction — both are 403s, and an operator reading a 403
 * must not be able to tell a flag from a role either — so the refused body carries this code
 * beside its sentence. The sentence is still the thing a person reads (`demoReset.previewRefusal`
 * in src/ui/copy.ts); this is what a surface branches on, so a copy edit cannot change what the
 * button does. It names no flag, no environment variable and no connection detail.
 *
 * Its own module, with no imports, because both halves need it: the route and the gate on the
 * server, and the client component in the header (src/ui/demo-day.ts) — which must not pull
 * ./reset.ts, a module that reaches the database and the auth tables, into the browser bundle.
 */
export const DEMO_RESET_REFUSAL = {
  /** The deployment's database is read-only: a preview. Expected, and not an error. */
  readOnlyDb: "read-only-db",
} as const;

export type DemoResetRefusal = (typeof DEMO_RESET_REFUSAL)[keyof typeof DEMO_RESET_REFUSAL];
