"use client";

import { useEffect, useRef } from "react";

/**
 * THE BOTTOM OF THE THREAD, brought into view when it opens.
 *
 * A thread opens at its newest message — that is what every messaging screen a parent or a
 * coordinator has ever used does, and on this screen it is the difference between a founder
 * seeing the approve controls and having to scroll for them: the proposal card is the last thing
 * in the thread, and a pane that opens at the top puts its three buttons under the fold.
 *
 * It is a marker and not a scroller: one empty element at the end of the list, which on mount
 * takes the pane it is in to the bottom. No animation, because this is the screen arriving
 * rather than a movement anybody asked for.
 *
 * Why a component rather than a `ref` on the list: the thread is a server component
 * (TextsScreen.tsx) and the one line of browser behaviour it needs should not drag the whole
 * screen into the client bundle. This is that line, by itself.
 */
export function ThreadEnd() {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    /*
     * The pane's own scroll, set to its maximum, rather than `scrollIntoView` on this marker:
     * `block: "end"` aligns the marker against the *padding* edge, which leaves the last row of
     * the card under the pane's bottom padding — 14 px short, and the shortfall is exactly the
     * thing this component exists to prevent.
     */
    const pane = end.current?.parentElement;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, []);
  return <div ref={end} aria-hidden="true" data-thread-end />;
}
