/**
 * The live stream's guard, over real HTTP, with no session at all (Veri's gate; ADR-002, ADR-004).
 *
 * Every other browser check in this directory runs against the server playwright.config.ts
 * starts, and that server is signed in: it is given `E2E_DEMO_ROLE`, the test-only synthetic
 * session, so there is no way to be anonymous on it. An unauthenticated request is therefore
 * the one thing the configured server cannot answer — and it is exactly the request Veri asks
 * about, so this spec starts a **second** server without that variable and asks it.
 *
 * It is the same build: `next start` over the `.next` the configured server already built, so
 * this costs a process and not a compile. No database, no credentials, nothing written down —
 * the only thing that differs from the configured server is the absent role.
 *
 * What it proves that the route's own tests cannot: that a real HTTP client with no session
 * gets 401 and **zero events** — not one frame, not a `retry:`, and a response that ends
 * instead of a connection that stays open.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { apiAccess } from "../src/ui/copy";

const REPO = path.resolve(__dirname, "..");
/** One past the port the configured server took, so two worktrees never collide on it. */
const PORT = Number(process.env.E2E_PORT ?? 3100) + 1;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let server: ChildProcessWithoutNullStreams | undefined;
let log = "";

/** The server is up when anything answers on the one route that needs no session. */
async function waitForServer(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`${ORIGIN}/api/health`);
      if (probe.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the signed-out server never came up on ${ORIGIN}\n${log}`);
}

test.beforeAll(async () => {
  server = spawn(
    path.join(REPO, "node_modules", ".bin", "next"),
    ["start", "--port", String(PORT), "--hostname", "127.0.0.1"],
    {
      cwd: REPO,
      env: {
        ...process.env,
        // ADR-015 / ADR-014: the same two switches the configured server runs with…
        APP_DATA_CLASS: "SYNTHETIC",
        DEMO_MODE: "1",
        // …and not the third. With no role there is no synthetic session, so every request
        // here is anonymous, which is the whole point of this server.
        E2E_DEMO_ROLE: undefined,
        AUTH_SECRET: randomBytes(32).toString("hex"),
        AUTH_TRUST_HOST: "true",
      },
    },
  );
  server.stdout.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  server.stderr.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  await waitForServer();
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

test.describe("GET /api/stream with no session", () => {
  test("answers 401 and sends zero events", async ({ request }) => {
    const response = await request.get(`${ORIGIN}/api/stream`, {
      headers: { accept: "text/event-stream" },
    });

    expect(response.status()).toBe(401);
    // Not a stream: a browser's `EventSource` would refuse this content type outright.
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(response.headers()["content-type"]).not.toContain("text/event-stream");
    expect(response.headers()["cache-control"]).toContain("no-store");

    // The body ends, which is itself part of the answer: a refusal is never a connection that
    // stays open. And nothing in it is a frame.
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: apiAccess.signIn });
    for (const framing of [/^retry:/m, /^id:/m, /^event:/m, /^data:/m]) {
      expect(body, "a refusal carries no SSE framing").not.toMatch(framing);
    }
  });

  test("learns nothing about the morning from a crafted resume point or clock speed", async ({
    request,
  }) => {
    // Everything the route reads off an allowed request, handed over at once. It is refused
    // before any of it is read, so none of it buys a single tick of the board.
    const response = await request.get(`${ORIGIN}/api/stream?speed=60&since=144&site=00000000-0000-0000-0000-00000000beef`, {
      headers: { accept: "text/event-stream", "last-event-id": "144" },
    });

    expect(response.status()).toBe(401);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: apiAccess.signIn });
    // No van, no child, no clock reading, no tick — nothing of the day is in a refusal.
    for (const name of ["V1", "V2", "snapshot", "delta", "clockText", "AM", "tick"]) {
      expect(body, `${name} reached a signed-out caller`).not.toContain(name);
    }
  });
});
