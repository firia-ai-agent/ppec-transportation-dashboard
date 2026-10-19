"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { agentRetryConfig } from "@/config/live";

/**
 * WHILE THE AGENT IS WORKING, THE SCREEN CATCHES UP ON ITS OWN.
 *
 * A family's text starts a run that the queue consumer drives (`/api/queues/agent`), so the card
 * the model writes lands a few seconds after the page was rendered — after Restart, after a text
 * comes in. The founder's demo is "the card shows up" in the bubble and on Family texts, so while
 * the shell knows a run is still QUEUED or RUNNING it re-renders the route, every few seconds,
 * until the run is done (the next render passes `working: false` and this stops) or a bound runs
 * out. A refresh re-reads rows on the server; it writes nothing and calls no model.
 */
export const AGENT_REFRESH_EVERY_MS = 3_000;
/**
 * Long enough for a person's run to ride out a busy model (ledger #75: an ask retries for four
 * minutes, one try a minute), short enough to never poll forever.
 */
export const AGENT_REFRESH_FOR_MS = (agentRetryConfig.retryForSeconds["staff.ask"] + agentRetryConfig.retryAfterSeconds) * 1000;

export function RefreshWhileAgentWorks({ working }: { working: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!working) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > AGENT_REFRESH_FOR_MS) {
        clearInterval(timer);
        return;
      }
      router.refresh();
    }, AGENT_REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, [working, router]);
  return null;
}
