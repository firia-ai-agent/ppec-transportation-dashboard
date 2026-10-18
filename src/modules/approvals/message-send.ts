/**
 * WHAT A MESSAGE-ONLY PROPOSAL IS CALLED — the names shared by everything that writes one and
 * everything that decides one.
 *
 * Firia's S1-7 ruling (2026-10-18), which answers run 7's open question: `send_followup` and
 * `request_clarification` are **human**-tier tools with a **propose** effect. The agent no longer
 * texts a family on its own authority; it writes one of these rows and a person decides it, the
 * same way a drop-off change is decided.
 *
 * ## Why a kind of its own, beside `DROPOFF_CHANGE`
 *
 * `ops.approval_request.proposal` is one `jsonb` column shared by every `propose_*` tool, so
 * `kind` is how a reader knows which shape it is holding — and these two shapes want different
 * guards:
 *
 *  - a **drop-off change** moves a child. It is guarded on `plan_run.version`, because approving
 *    it writes the plan, and a plan that moved while the card was open makes the text wrong.
 *  - a **message** moves nothing. There is no plan write to guard, and so (Firia, S1-7) **no
 *    `plan_run` version check for message-only kinds**: a plan that changed since the question was
 *    asked does not make "which child did you mean?" wrong. What it is guarded on instead is the
 *    exact text a person approved, and the outbox's own re-checks at drain.
 *
 * Reading them apart by `kind` is what keeps one card from applying the other's rules. The guard
 * each gets is in `decide.ts`; what a row holds is in `agent/run/exec/proposals.ts`.
 *
 * No imports here, for the same reason `dropoff-change.ts` has none: three string constants
 * should not drag a database handle behind them (see that file's header for the suite it broke).
 */

/** `proposal ->> 'kind'` for a message a person has to approve before it is sent. */
export const MESSAGE_SEND_KIND = "MESSAGE_SEND";

/**
 * `ops.task.category` for the exception a message proposal opens.
 *
 * Not `PLAN_CHANGE`: nothing about the day's plan is being proposed. What is waiting is a reply
 * to a family, which is a different thing for a coordinator to pick up and a different thing for
 * the board to count.
 */
export const MESSAGE_SEND_TASK_CATEGORY = "FAMILY_MESSAGE";

/**
 * The two §11.2 tools that write this kind. Named here so the proposal writer, the registry's
 * `PROPOSAL_ONLY_TOOLS` and the suites all read one list.
 */
export const MESSAGE_SEND_TOOLS: readonly string[] = ["send_followup", "request_clarification"];
