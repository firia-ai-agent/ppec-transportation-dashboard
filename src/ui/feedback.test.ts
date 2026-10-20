import { describe, expect, it, vi } from "vitest";
import { API, endpointRow, ALL_STAFF } from "@/auth/access";
import { sendFeedback } from "./Feedback";

describe("the DEMO bar's Feedback button (ledger #82)", () => {
  it("posts the words in the body to the feedback route, never in the URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    expect(await sendFeedback("Bigger buttons", "/ramp-ipad", fetchImpl as unknown as typeof fetch)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(API.feedback);
    expect(url).not.toContain("Bigger");
    expect(JSON.parse(String(init.body))).toEqual({ body: "Bigger buttons", pagePath: "/ramp-ipad" });
  });

  it("says false when the server refuses", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 403 }));
    expect(await sendFeedback("x", "/today", fetchImpl as unknown as typeof fetch)).toBe(false);
  });

  it("is every role's to send and only the director's to read", () => {
    expect(endpointRow(API.feedback)?.auth).toMatchObject({ kind: "session", roles: ALL_STAFF });
    expect(endpointRow(API.feedbackOpen)?.auth).toMatchObject({ kind: "session", roles: ["DIRECTOR"] });
  });
});
