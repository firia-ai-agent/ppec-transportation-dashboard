/**
 * ONE MAPPING, USED BOTH WAYS: the tokens the model reads ↔ the ids the database holds.
 *
 * ## The mismatch this closes
 *
 * `identity/names.ts` tokenizes a family's text before it reaches a prompt, and the token it
 * substitutes is the *fixture key* — "can Noah be dropped at 5" arrives at the model as "can C2 be
 * dropped at 5". So the model reads `C2`, and the only sensible thing it can do with a drop-off
 * question about `C2` is call a tool naming `C2`.
 *
 * The scope it is judged against held something else. `assembler.ts` builds `FamilyScope` from the
 * operational rows — `ops.child_profile.child_token`, `ops.trip_leg.id`, the thread id, the
 * message ids — and every one of those is a uuid. So a model that did exactly the right thing
 * with the context it was given got `cross_family_disclosure` and a refused call, because `C2` is
 * not in a set of uuids. The context said one language and the gate listened for another.
 *
 * This module is the dictionary between them, and the assembler builds exactly one per run:
 *
 *  - **outward**, `tokenFor(id)` — every id the tiers name is written as its token, so T1, T2 and
 *    T3 agree: `children=C2`, `leg=L-C2-PM`, `thread=TH-F2`, and the tokenized message body that
 *    already said `C2` now says the same thing the rest of the prompt does. The prompt also gets
 *    shorter and far easier for a reviewer to read, which is a real benefit and not the reason.
 *  - **inward**, `idFor(token)` — a tool call's arguments are resolved back before the policy
 *    engine sees them (`run/loop.ts`), so `cancel_attendance_or_leg(child_token: "C2")` is judged,
 *    and executed, against the uuid the row actually has.
 *
 * ## Why resolving inward is safe, and is not a hole in the gate
 *
 * The mapping is **built from this run's scope and nothing else**. `scopeTokens()` is handed the
 * pairs the assembler read for this family on this site, so:
 *
 *  - `idFor("C2")` answers only when C2 is one of *this* run's children. A model that names `C7`
 *    — another family's child, whose token this process can derive perfectly well from the
 *    fixtures — gets `null`, the argument is left exactly as the model wrote it, and
 *    `validateFamilyScope` refuses it like any other out-of-scope reference. Resolution cannot
 *    widen a scope; it can only name something already inside one.
 *  - a token this run does not hold is never *rewritten into* an id, so there is no path on which
 *    a guessed or injected token becomes a real row. The refusal is unchanged, including its
 *    audit classification.
 *
 * In other words the gate still decides; this only stops it refusing calls it meant to allow.
 *
 * ## DEMO-ONLY, and what replaces it (PRD §11.1, B-07/P-08)
 *
 * The id→token half of the stable entities is derived by **inverting the deterministic demo id
 * function** over the fixture set (`demoId`, `demoChildToken`, `demoLegId` in
 * src/modules/demo/fixtures/standard.ts) — the same function the seed used to write the rows, run
 * backwards. That works because every demo id is `demoId(kind, index + 1)` over a fixture array,
 * and it works *only* for synthetic data (ADR-015): an id no fixture accounts for has no token and
 * is passed through as itself.
 *
 * So this is a demo-only mapping, and it is deliberately not an identity vault. It maps ids to
 * ids — a uuid to a short label — and reads no name, no phone number and no address; the name
 * vault is still P-08's, exactly as `identity/names.ts` (its header) says, and nothing here
 * handles a real person's name. When the vault lands, the stable half of this table comes from the
 * vault's own token index instead, behind the same two functions, and no caller changes.
 *
 * Pure module: no database, no `next/*`, no environment.
 */
import {
  CHILDREN,
  FAMILIES,
  KIND,
  PROVIDERS,
  THERAPY_SESSIONS,
  VEHICLES,
  demoChildToken,
  demoId,
  demoLegId,
} from "@/modules/demo/fixtures/standard";

/** One entry in the dictionary: what the model calls the thing, and what the database calls it. */
export type ScopeTokenPair = {
  /** The short label the prompt and the tool calls use: "C2", "L-C2-PM", "TH-F2", "MSG-1". */
  readonly token: string;
  /** The operational id: a uuid, in every table this reads from. */
  readonly id: string;
};

/**
 * The mapping, both ways. Built once per assembled context and carried on it, so the prompt that
 * was written and the call that comes back are read through the same dictionary — a second mapping
 * built somewhere else is the bug this type exists to make impossible.
 */
export type ScopeTokens = {
  /** The token for an id, or the id itself when this run has no token for it. Never throws. */
  readonly tokenFor: (id: string) => string;
  /** The id for a token, or `null` — which means "not this run's", and is a refusal upstream. */
  readonly idFor: (token: string) => string | null;
  /** Every pair, for the audit and for tests. */
  readonly pairs: readonly ScopeTokenPair[];
};

/**
 * Build the dictionary from this run's pairs.
 *
 * Later pairs lose: the assembler adds the stable fixture-derived entities first and the per-run
 * ones (thread, messages) after, and a duplicate must not silently redefine a token that is
 * already pointing at a row. Both directions are built from the same list, so they cannot
 * disagree about a pair — which is the whole point of there being one table.
 */
export function scopeTokens(pairs: readonly ScopeTokenPair[]): ScopeTokens {
  const byToken = new Map<string, string>();
  const byId = new Map<string, string>();
  const kept: ScopeTokenPair[] = [];
  for (const pair of pairs) {
    if (!pair.token || !pair.id) continue;
    if (byToken.has(pair.token) || byId.has(pair.id)) continue;
    byToken.set(pair.token, pair.id);
    byId.set(pair.id, pair.token);
    kept.push(pair);
  }
  return {
    tokenFor: (id) => byId.get(id) ?? id,
    idFor: (token) => byToken.get(token) ?? null,
    pairs: kept,
  };
}

/** An empty dictionary: every id is its own token and no token resolves. The safe default. */
export const NO_SCOPE_TOKENS: ScopeTokens = scopeTokens([]);

/* ─────────────────── the demo inverse: an id, read back to its fixture key ─────────────────── */

/**
 * Every id the fixture set can account for, mapped to the label the fixtures know it by.
 *
 * Built once at module load by running the seed's own id functions forward over the fixture
 * arrays. The leg token is the one that is composed rather than copied — a leg has no fixture key,
 * so it takes the shape the agent's own test fixtures have used all along, `L-<child>-<AM|PM>`
 * (see `run/harness.ts`), which keeps one vocabulary across the tests and the live path.
 */
const DEMO_TOKEN_BY_ID: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  FAMILIES.forEach((f, i) => m.set(demoId(KIND.family, i + 1), f.key));
  for (const child of CHILDREN) {
    m.set(demoChildToken(child.key), child.key);
    m.set(demoLegId(child.key, "AM"), `L-${child.key}-AM`);
    m.set(demoLegId(child.key, "PM"), `L-${child.key}-PM`);
  }
  VEHICLES.forEach((v, i) => m.set(demoId(KIND.vehicle, i + 1), v.key));
  PROVIDERS.forEach((p, i) => m.set(demoId(KIND.provider, i + 1), p.key));
  THERAPY_SESSIONS.forEach((s, i) => m.set(demoId(KIND.session, i + 1), s.key));
  return m;
})();

/**
 * The fixture label for a synthetic id, or `null` when no fixture accounts for it.
 *
 * `null` is the honest answer for a row this deployment did not seed, and the callers treat it as
 * "use the id": a real id is passed through unchanged rather than guessed at.
 */
export function demoTokenForId(id: string): string | null {
  return DEMO_TOKEN_BY_ID.get(id) ?? null;
}

/** The pair for a synthetic id, or nothing — the shape `scopeTokens()` takes. */
export function demoPairsFor(ids: readonly string[]): ScopeTokenPair[] {
  const out: ScopeTokenPair[] = [];
  for (const id of ids) {
    const token = demoTokenForId(id);
    if (token) out.push({ token, id });
  }
  return out;
}

/* ─────────────────────────── inward: a tool call, resolved ─────────────────────────── */

/**
 * The model's arguments with every in-scope token replaced by the id it stands for.
 *
 * **Whole values only.** A string leaf is replaced when the *entire* value is a token this run
 * holds — never a token found inside a sentence. That rule is what keeps a staff note readable: a
 * summary that says "C2 is being collected early" is prose for a person to read and stays as
 * written, while `child_token: "C2"` is a reference and is resolved. It also means resolution
 * cannot corrupt a body, a template id, a date or a reason code, none of which can equal a token.
 *
 * Structure is preserved exactly — objects, arrays and nesting — because `approvalKey` fingerprints
 * these arguments and the policy engine walks them by path. Unresolvable values are left
 * untouched, which is what sends them to the refusal they deserve.
 */
export function resolveScopeTokens(
  args: Record<string, unknown>,
  tokens: ScopeTokens,
): Record<string, unknown> {
  return walk(args, tokens) as Record<string, unknown>;
}

function walk(value: unknown, tokens: ScopeTokens): unknown {
  if (typeof value === "string") return tokens.idFor(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => walk(v, tokens));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, tokens)]));
  }
  return value;
}
