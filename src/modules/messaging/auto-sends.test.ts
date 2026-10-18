/**
 * **Firia's gate 4, from underneath**: which templates the day is allowed to send by itself.
 *
 * The screen half — "Auto · Delivered" on those and on nothing else — is
 * `app/(app)/family-texts/texts-screen.test.ts`. This is the list that label is computed from, and
 * the reason it is a list rather than a negation: a template nobody has thought about must not
 * inherit the friendlier label by default.
 *
 * So three things are checked. The allow-list is exactly the §8 notices plus the one fixed-copy
 * inbound answer; the three templates that say a *decision* was made (`followup.ts`'s
 * `DECISION_TEMPLATES`) are not on it; and every template the two sets name is one the renderer
 * actually knows, so neither list can rot into a set of strings that match nothing.
 */
import { describe, expect, it } from "vitest";
import { DECISION_TEMPLATES } from "@/modules/agent/run/exec/followup";
import { AUTO_SEND_TEMPLATES, isAutoSend } from "./auto-sends";
import { HELP_REPLY_TEMPLATE, knownTemplates } from "./templates";

describe("the templates the day sends by itself", () => {
  it("is exactly this list", () => {
    expect([...AUTO_SEND_TEMPLATES].sort()).toEqual([
      HELP_REPLY_TEMPLATE,
      "dropoff.eta",
      "dropoff.late",
      /*
       * The handoff notice, added with the day's own threads (Firia, 2026-10-17 10:51 PM ET —
       * the five threads come from fixture data). Nobody chooses to send it: the day sends it
       * because a custody event was recorded, which is what makes it an auto send and not a
       * decision.
       */
      "dropoff.received",
      "pickup.eta",
    ].sort());
  });

  it("holds no template that says a decision was made", () => {
    for (const templateId of DECISION_TEMPLATES) {
      expect(AUTO_SEND_TEMPLATES.has(templateId), templateId).toBe(false);
      expect(isAutoSend(templateId), templateId).toBe(false);
    }
    // And the decision set is not empty, so the loop above is not vacuous.
    expect(DECISION_TEMPLATES.size).toBeGreaterThan(0);
  });

  it("names only templates the renderer knows", () => {
    const known = new Set(knownTemplates());
    for (const templateId of [...AUTO_SEND_TEMPLATES, ...DECISION_TEMPLATES]) {
      expect(known.has(templateId), templateId).toBe(true);
    }
  });

  it("treats an unknown template, and no template at all, as not auto", () => {
    expect(isAutoSend(null)).toBe(false);
    expect(isAutoSend(undefined)).toBe(false);
    expect(isAutoSend("")).toBe(false);
    expect(isAutoSend("something.new")).toBe(false);
  });
});
