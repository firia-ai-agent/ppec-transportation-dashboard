import { expect, it } from "vitest";
import { healthPayload } from "./health";

it("reports commit and data class, no secrets", () => {
  const p = healthPayload({ VERCEL_GIT_COMMIT_SHA: "abc123", APP_DATA_CLASS: "SYNTHETIC", AUTH_SECRET: "x" });
  expect(p.commit).toBe("abc123");
  expect(p.dataClass).toBe("SYNTHETIC");
  expect(JSON.stringify(p)).not.toContain("AUTH_SECRET");
});
