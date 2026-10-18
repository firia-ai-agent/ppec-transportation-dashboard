/**
 * THE PLAN-PLACEMENT PORT — the one way an approval is allowed to change the plan.
 *
 * Firia's gap-5 ruling (2026-10-17): an approved drop-off **change** or **cancel** has to save a
 * new plan version, and a cancel has to put the child in the `ABSENT` bucket *through the same
 * exported function the board uses*. That function is `setChildPlacement` in `@/modules/plan`,
 * which is being built on `team/ppe-rework-ramp-board` and is not pushed yet.
 *
 * So this file is the shape of it and nothing else. There is deliberately **no implementation
 * here**: a second writer of `plan_run` / `plan_assignment`, written to unblock this branch,
 * is exactly how two code paths end up disagreeing about what a plan version means — and the
 * board's writer is the one that owns the optimistic-version contract, the bucket vocabulary and
 * the audit stamp. A port with no implementation is honest about what is missing; a copy of the
 * writer would not be.
 *
 * ## What happens until it is wired
 *
 * `decideApproval` takes this as a dependency and production passes `null`, because there is
 * nothing to pass. An approval then **fails safe**: the transaction rolls back, the decision is
 * not claimed, nothing is queued to the family, and the coordinator reads "Couldn't update the
 * plan" (`approval.planNotSaved`). It never reports success, and it never texts a family about a
 * change that was not saved — which is the one failure mode that would actually hurt somebody.
 *
 * ## Where absence is read
 *
 * From `plan_assignment`, and from nowhere else. `attendance_day` keeps its own record — the
 * front desk's actual-attendance row is a different fact, recorded by a different person — but no
 * screen reads absence from it (`plan-placement-port.test.ts` holds that line with a grep).
 */

/** The buckets a child can be in on the board, as the board's own writer names them. */
export type PlacementBucket = "VAN" | "ABSENT" | "FAMILY_DRIVES" | "UNASSIGNED";

/** One placement write, in the shape `@/modules/plan setChildPlacement` takes. */
export type SetChildPlacementInput = {
  readonly siteId: string;
  readonly serviceDate: string;
  readonly direction: string;
  readonly childToken: string;
  readonly bucket: PlacementBucket;
  /** Set only for `VAN`: which vehicle the child rides in after the change. */
  readonly vehicleId?: string;
  /** The plan version this write is guarded on. A plan that has moved since is a conflict. */
  readonly expectedVersion: number;
  readonly actor: string;
};

/** What a placement write answers: the new plan version, or why it did not land. */
export type SetChildPlacementResult = {
  readonly ok: boolean;
  /** The version the plan now holds. Present only when `ok`. */
  readonly planVersion?: number;
};

/**
 * The board's placement writer.
 *
 * Implemented by `@/modules/plan` `setChildPlacement` on `team/ppe-rework-ramp-board`; wire it
 * when that branch is merged, by passing it where `decideApproval` is called from
 * `src/app/(app)/family-texts/actions.ts`. Until then that call site passes `null` and an
 * approval refuses rather than pretending (see the file header).
 */
export type SetChildPlacement = (input: SetChildPlacementInput) => Promise<SetChildPlacementResult>;
