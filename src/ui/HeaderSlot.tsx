"use client";

import { useEffect, useState } from "react";
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
 * Portals only after mount, and renders nothing before: the slot is in the DOM the server sent,
 * but `document` is not, and a screen's controls appearing on hydration is better than a
 * hydration mismatch in the one bar every page has.
 */
export function HeaderSlot({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<Element | null>(null);

  useEffect(() => {
    setHost(document.querySelector("[data-header-slot]"));
    // The bar is mounted once per layout and lives as long as the screen does, so there is
    // nothing to tear down: leaving the portal is React's own job when this unmounts.
  }, []);

  return host ? createPortal(children, host) : null;
}
