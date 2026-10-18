import { describe, expect, it } from "vitest";
import { GPS_FRESH_SECONDS, GPS_LOST_SECONDS, GPS_STALE_SECONDS } from "./freshness";
import { VAN_CHIPS, vanChipOf } from "./van-chip";
import { liveMap } from "@/ui/copy";

// Source: Firia ruling (10:49 PM ET, goal 5): state chips On route, At stop, Late, No GPS, no ETAs.
// Staleness bands: LOC-03 (src/domain/location/freshness.ts).
describe("vanChipOf", () => {
  const fresh = 0;
  it("is On route when the fix is fresh, not at a stop and not behind", () => {
    expect(vanChipOf({ gpsAgeSeconds: fresh, atStop: false, behind: false })).toBe("onRoute");
  });
  it("is At stop inside a stop geofence", () => {
    expect(vanChipOf({ gpsAgeSeconds: fresh, atStop: true, behind: false })).toBe("atStop");
  });
  it("is Late when the leg is behind, even at a stop", () => {
    expect(vanChipOf({ gpsAgeSeconds: fresh, atStop: true, behind: true })).toBe("late");
  });
  it("aging GPS still shows the van's state", () => {
    expect(vanChipOf({ gpsAgeSeconds: GPS_FRESH_SECONDS, atStop: false, behind: false })).toBe("onRoute");
  });
  it("is No GPS from the stale band on, and beats Late", () => {
    for (const age of [GPS_STALE_SECONDS, GPS_LOST_SECONDS, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(vanChipOf({ gpsAgeSeconds: age, atStop: true, behind: true })).toBe("noGps");
    }
  });
  it("every chip has its words in copy.ts, and there are exactly four", () => {
    expect(VAN_CHIPS).toHaveLength(4);
    expect(VAN_CHIPS.map((c) => liveMap.chips[c])).toEqual(["On route", "At stop", "Late", "No GPS"]);
  });
});
