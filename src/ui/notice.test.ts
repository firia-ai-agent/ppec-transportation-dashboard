import { describe, expect, it } from "vitest";
import { toast } from "./copy";
import { NOTICE_PARAM, NOT_ON_YOUR_MENU, noticeMessage, withNotice } from "./notice";

/**
 * The redirect's one line (§9.3). The guard and the toast share this module, so the parameter
 * the server writes and the one the browser reads cannot drift apart — which would be a silent
 * redirect, the thing the notice exists to prevent.
 */
describe("the notice a redirect carries", () => {
  it("turns a known key into the sentence, and an unknown one into nothing", () => {
    expect(noticeMessage(NOT_ON_YOUR_MENU)).toBe(toast.notOnMenu);
    expect(noticeMessage("whatever-a-visitor-typed")).toBeNull();
    expect(noticeMessage(null)).toBeNull();
    expect(noticeMessage("")).toBeNull();
  });

  it("adds the parameter without losing the query a path already has", () => {
    expect(withNotice("/live-map", NOT_ON_YOUR_MENU)).toBe(`/live-map?${NOTICE_PARAM}=${NOT_ON_YOUR_MENU}`);
    expect(withNotice("/today?date=2026-10-17", NOT_ON_YOUR_MENU)).toBe(
      `/today?date=2026-10-17&${NOTICE_PARAM}=${NOT_ON_YOUR_MENU}`,
    );
  });

  /** A key in the URL, never a sentence: the address bar is not a place to write copy from. */
  it("puts no words in the address", () => {
    expect(withNotice("/live-map", NOT_ON_YOUR_MENU)).not.toContain(" ");
    expect(withNotice("/live-map", NOT_ON_YOUR_MENU)).not.toContain(toast.notOnMenu);
  });
});
