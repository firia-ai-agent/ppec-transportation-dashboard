/**
 * The shape of one action in the action layer (`registry.ts`, ledger #74): who acts, what they send,
 * whether a person must press it, and the function it runs.
 */
import type { z } from "zod";
import type { StaffRole } from "@/auth/core";

/** Who is acting, where, and when. The person — a screen's session, or the asker the agent acts for. */
export type ActionCtx = {
  readonly siteId: string;
  /** `userId` as the session has it: a session with none is refused by each action (401). */
  readonly caller: { readonly userId: string | undefined; readonly role: StaffRole };
  readonly now: Date;
};

/** What every action answers: the status and body its route already returned. */
export type ActionAnswer = { readonly status: number; readonly body: unknown };

export type ActionEntry<I = unknown, A extends ActionAnswer = ActionAnswer> = {
  readonly name: string;
  /** The action's row in the access table: whose it is. */
  readonly endpoint: string;
  readonly input: z.ZodType<I>;
  /** A person presses this one: the agent may only propose it (PRD §11.2, ledger #74 d). */
  readonly confirm: boolean;
  /** One plain line saying what this would do — the confirm card's words, and the agent's report. */
  readonly describe: (input: I) => string;
  /** The answer the action's own domain function gives, typed as that function types it. */
  readonly run: (ctx: ActionCtx, input: I) => Promise<A>;
};

export const entry = <I, A extends ActionAnswer>(e: ActionEntry<I, A>): ActionEntry<I, A> => e;

