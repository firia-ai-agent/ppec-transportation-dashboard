import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { freshPlanDb, SITE } from "@/test/pglite";
import { addFeedback, feedbackBody, openFeedback } from "./store";
import { FEEDBACK_MAX } from "./limits";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
}, 180_000);

afterAll(async () => {
  await close();
});

describe("staff feedback (ledger #82)", () => {
  it("keeps the line with the standard columns, and the director's list reads it back newest first", async () => {
    const first = await addFeedback(db, {
      siteId: SITE, by: "staff:u-c", pagePath: "/today", body: "The board needs a print view",
      now: new Date("2026-10-19T20:00:00Z"),
    });
    await addFeedback(db, {
      siteId: SITE, by: "staff:u-f", pagePath: "/ramp-ipad", body: "Bigger buttons on the ramp",
      now: new Date("2026-10-19T21:00:00Z"),
    });
    const row = await db.query<{ status: string; version: number; created_by: string; source_mode: string }>(
      "SELECT status, version, created_by, source_mode FROM ops.feedback WHERE id = $1",
      [first.id],
    );
    expect(row.rows[0]).toMatchObject({ status: "OPEN", version: 1, created_by: "staff:u-c", source_mode: "SIMULATED" });

    const open = await openFeedback(db, SITE);
    expect(open.map((item) => [item.pagePath, item.body, item.by])).toEqual([
      ["/ramp-ipad", "Bigger buttons on the ramp", "staff:u-f"],
      ["/today", "The board needs a print view", "staff:u-c"],
    ]);
  });

  it("writes one audit line that names the row and never carries the words", async () => {
    const saved = await addFeedback(db, {
      siteId: SITE, by: "staff:u-d", pagePath: "/plan-routes", body: "secret-ish words",
      now: new Date("2026-10-19T22:00:00Z"),
    });
    const audit = await db.query<{ actor: string; action: string; detail: unknown }>(
      "SELECT actor, action, detail FROM ops.audit_event WHERE entity = 'feedback' AND entity_id = $1",
      [saved.id],
    );
    expect(audit.rows).toEqual([{ actor: "staff:u-d", action: "feedback.add", detail: null }]);
  });

  it("refuses an empty line, an overlong one, and a full URL for the page", () => {
    expect(feedbackBody.safeParse({ body: "  ", pagePath: "/today" }).success).toBe(false);
    expect(feedbackBody.safeParse({ body: "x".repeat(FEEDBACK_MAX + 1), pagePath: "/today" }).success).toBe(false);
    expect(feedbackBody.safeParse({ body: "ok", pagePath: "https://evil.example/today" }).success).toBe(false);
    expect(feedbackBody.safeParse({ body: " ok ", pagePath: "/family-texts?tab=you" }).data?.body).toBe("ok");
  });
});
