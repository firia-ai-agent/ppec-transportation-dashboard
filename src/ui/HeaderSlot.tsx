"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * A SCREEN'S OWN CONTROLS, IN THE FRAME'S HEADER BAR.
 *
 * The founder's mockups put a screen's switch inside the 64 px page header rather than in a
 * second strip under it: the Live map's Morning|Afternoon segmented control and its three state
 * counts sit on the same line as the title (mockups/live-map.html; png/live-map.png at 1440,
 * png/live-map-390.png at 390, where the counts drop out and the segmented control stays).
 *
 * The bar is rendered by the shell (src/ui/PageHeader.tsx) and the screen is a child of the
 * layout that mounts it, so there is no prop to pass upward. This portals instead: the bar
 * leaves one empty `[data-header-slot]` element, and a screen renders into it. The frame still
 * knows nothing about any screen — it owns a slot, not a toolbar.
 *
 * It renders nothing on the server (the server snapshot is `null`), so the server's markup and the
 * first client render agree. In the browser it is `useSyncExternalStore` over the document rather
 * than a `useState` an effect flips: the lint rule the repo runs with forbids `setState` in an
 * effect body, and a store is the documented way to read something outside React.
 */

/**
 * WHY THE SLOT IS WATCHED, NOT LOOKED UP ONCE (S1, Firia 7:55 AM ET: no Morning | Afternoon on the
 * default /plan-routes). On a soft navigation — the menu's `<Link>` from Today, or the sign-in
 * redirect — the screen and a *new* header bar mount in the same commit (Plan routes has its own
 * layout), so during render `[data-header-slot]` is not in the document yet. A one-shot lookup
 * returned null and nothing ever asked again: the toolbar, leg switch included, was never drawn
 * until a full page load (which the leg links are). So the snapshot is the slot element itself,
 * and the subscription tells React when it may have changed.
 *
 * The watch is as small as it can be (Veri's gate, 8:09 AM ET):
 *  - **searching**: no slot yet, so one observer on the body's subtree, until the slot appears;
 *  - **found**: that observer is disconnected. What is left is one `childList` observer (no
 *    subtree) on each ancestor of the slot, which fires only when the slot or a node above it is
 *    added or removed — never on the board's own drags and re-renders. If the slot has left the
 *    document (a header remount), React is told and the search starts again; otherwise nothing.
 *  - unsubscribe (unmount) disconnects whatever is attached.
 */
export const SLOT_SELECTOR = "[data-header-slot]";

export function subscribeToSlot(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  let observers: MutationObserver[] = [];
  const stop = () => {
    for (const observer of observers) observer.disconnect();
    observers = [];
  };
  const watchSlot = (slot: Element) => {
    stop();
    const onAncestorChange = () => {
      if (slot.isConnected) return;
      onChange();
      search();
    };
    for (let node: Node | null = slot.parentNode; node; node = node.parentNode) {
      const observer = new MutationObserver(onAncestorChange);
      observer.observe(node, { childList: true });
      observers.push(observer);
      if (node === document.body) break;
    }
  };
  const search = () => {
    stop();
    const found = document.querySelector(SLOT_SELECTOR);
    if (found) {
      watchSlot(found);
      return;
    }
    const observer = new MutationObserver(() => {
      const slot = document.querySelector(SLOT_SELECTOR);
      if (!slot) return;
      watchSlot(slot);
      onChange();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    observers.push(observer);
  };
  search();
  return stop;
}

export function slotSnapshot(): Element | null {
  return typeof document === "undefined" ? null : document.querySelector(SLOT_SELECTOR);
}

export function HeaderSlot({ children }: { children: ReactNode }) {
  const host = useSyncExternalStore(subscribeToSlot, slotSnapshot, () => null);
  return host ? createPortal(children, host) : null;
}
