"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ConfirmAction, StaleNoteAction } from "@/modules/actions/confirm-view";
import type { DecideAction } from "@/app/(app)/family-texts/actions";

/**
 * WHAT A PANEL'S BUTTONS RUN, PROVIDED ONCE (ledger #79). The console shell mounts this with the
 * two server actions behind every panel — a family reply's decision and a confirmed change — so a
 * panel drawn on any screen decides the same way, and a page does not import the writers itself.
 */
export type PanelActions = {
  readonly decide: DecideAction;
  readonly confirm: ConfirmAction;
  /** A stale card's Dismiss and Open Plan routes. */
  readonly dismissStale?: StaleNoteAction;
  readonly openStale?: StaleNoteAction;
};

const Ctx = createContext<PanelActions | null>(null);

export function PanelActionsProvider({ actions, children }: { readonly actions: PanelActions; readonly children: ReactNode }) {
  return <Ctx.Provider value={actions}>{children}</Ctx.Provider>;
}

export function usePanelActions(): PanelActions | null {
  return useContext(Ctx);
}
