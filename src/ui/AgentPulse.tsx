"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { API } from "@/auth/access";

/**
 * THE SCREEN HEARS THE AGENT (ledger #75 b).
 *
 * Every page the bubble is on asks the pulse (`/api/agent/thread/pulse`) whether the agent's thread
 * has moved since the page rendered, and re-renders when it has — so a van confirmed short at the
 * ramp reaches the coordinator on Today within seconds, without a reload, the way a colleague would
 * walk over. Every few seconds while a run is on its way, less often otherwise, and only while the
 * tab is in front of somebody. A pulse reads two numbers; it writes nothing and calls no model.
 *
 * It replaces the old "refresh every 3 s while a run is working" loop, which only ever started if
 * the page already knew a run was working when it rendered.
 */
export const PULSE_EVERY_MS = 10_000;
export const PULSE_WHILE_WORKING_MS = 3_000;

export function AgentPulse({ stamp, working }: { stamp: string; working: boolean }) {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(API.agentPulse, { cache: "no-store" });
        if (!response.ok) return;
        const now = (await response.json()) as { stamp?: string; working?: boolean };
        if (!stopped && (now.stamp !== stamp || Boolean(now.working) !== working)) router.refresh();
      } catch {
        /* offline or signed out: the next tick asks again */
      }
    };
    const timer = setInterval(tick, working ? PULSE_WHILE_WORKING_MS : PULSE_EVERY_MS);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [stamp, working, router]);
  return null;
}
