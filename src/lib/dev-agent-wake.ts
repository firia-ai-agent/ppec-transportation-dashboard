/**
 * A LOCAL DEV SERVER'S AGENT QUEUE (ledger #76).
 *
 * `next dev` has no Vercel Queue, so an agent run published there would sit QUEUED for ever. On a
 * dev server only, a wake-up is posted to the server's own consumer route (`/api/dev/agent-wake`),
 * which runs the queue route's code. Outside `src/modules/agent` on purpose: the agent module holds
 * no network call of its own (VERI-5, no-network.test.ts); this is the host's plumbing, not the
 * agent's.
 */
export function drivesAgentLocally(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL !== "1" && env.NODE_ENV === "development";
}

export function postLocalAgentWake(msg: unknown, env: Record<string, string | undefined> = process.env): void {
  const origin = env.__NEXT_PRIVATE_ORIGIN ?? `http://localhost:${env.PORT ?? "3000"}`;
  setTimeout(() => {
    void fetch(`${origin}/api/dev/agent-wake`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.CRON_SECRET ?? ""}` },
      body: JSON.stringify(msg),
    }).catch((e) => console.error("[queue:agent:local]", e instanceof Error ? e.message : e));
  }, 0);
}
