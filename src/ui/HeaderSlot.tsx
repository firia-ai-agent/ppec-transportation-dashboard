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
 * It renders nothing until the browser has hydrated, and the hydration check is
 * `useSyncExternalStore` rather than a `useState` an effect flips. Both would work; only one is
 * allowed. React's own guidance — and the lint rule the repo runs with — is that an effect
 * synchronises with an external system and does not call `setState` in its body, because that is
 * a second render every time. A store whose snapshot is `false` on the server and `true` in the
 * browser is the documented way to ask "am I hydrated yet", with no subscription and no cascade.
 *
 * Reading the DOM during render is safe for exactly the same reason: it only ever happens on the
 * client pass, after hydration, where `[data-header-slot]` is already in the document the server
 * sent. Before that the snapshot is `false` and this renders `null`, so the server's markup and
 * the first client render agree.
 */

/** Nothing to subscribe to: the question is only ever asked once, by rendering. */
const subscribe = () => () => {};

export function HeaderSlot({ children }: { children: ReactNode }) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const host = hydrated ? document.querySelector("[data-header-slot]") : null;
  return host ? createPortal(children, host) : null;
}
