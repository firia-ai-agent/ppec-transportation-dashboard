import { describe, expect, it } from "vitest";
import { CLOSURE_REASON_CODES, LEG_CANCEL_REASON_CODES, TEMPLATE_VARS } from "@/modules/outbox/outbox";
import { outboundSms } from "@/ui/copy";
import { HELP_REPLY_BODY, HELP_REPLY_TEMPLATE, knownTemplates, renderTemplate, templatePlaceholders, TemplateRenderError } from "./templates";

/**
 * One rule-abiding value per var name (outbox TEMPLATE_VARS value rules, Veri #12). Since those
 * rules reject free text, a sample that "looks like" copy is no longer usable: a stop is a token, a
 * time is HH:MM, a reason is a code.
 */
const SAMPLE: Record<string, string> = {
  childFirstName: "Syn",
  stopLabel: "STOP-4",
  eta: "08:12",
  sessionStart: "13:30",
  legDate: "2026-10-14",
  date: "2026-10-14",
};
const sampleVars = (templateId: string, reasonCode = "WEATHER"): Record<string, string> =>
  Object.fromEntries(Object.keys(TEMPLATE_VARS[templateId]).map((v) => [v, v === "reasonCode" ? reasonCode : SAMPLE[v]]));

describe("outbound SMS templates (COPY-GUIDE §5)", () => {
  it("every outbox template has a body and every placeholder is an allowlisted var", () => {
    expect(knownTemplates().sort()).toEqual(Object.keys(TEMPLATE_VARS).sort());
    for (const t of knownTemplates()) {
      for (const v of templatePlaceholders(t)) expect(Object.hasOwn(TEMPLATE_VARS[t], v), `${t} uses ${v}`).toBe(true);
      for (const v of Object.keys(TEMPLATE_VARS[t])) expect(SAMPLE[v] ?? v === "reasonCode", `${t} var ${v} has a sample`).toBeTruthy();
    }
  });

  it("no ticket codes, enum names, emoji or banned words reach a family (COPY-GUIDE §2)", () => {
    for (const t of knownTemplates()) {
      const body = renderTemplate(t, sampleVars(t));
      expect(body, t).not.toMatch(/\b(?:MSG|NTF|PPE|AT|ADR|PRD|CQ|VEH|TRP|LOC|AGT|RES)-\d/i);
      expect(body, t).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/); // enum names stay on developer surfaces
      expect(body, t).not.toMatch(/\b(?:load|unload|cargo|pax|patient|handicapped|ASAP|URGENT)\b/i);
      expect(body, t).not.toMatch(/wheelchair-bound|special needs|[\u{1F300}-\u{1FAFF}]|!/u);
      expect(body, t).toContain("[DEMO]"); // COPY-GUIDE §6: a simulated message says so
      expect(body, t).toMatch(/^PPEC: /);
    }
  });

  it("every reason code has copy, and the code itself never reaches a family", () => {
    for (const [t, codes] of [["leg.canceled", LEG_CANCEL_REASON_CODES], ["center.closure", CLOSURE_REASON_CODES]] as const) {
      for (const code of codes) {
        const body = renderTemplate(t, sampleVars(t, code));
        expect(body, `${t}/${code}`).not.toContain(code);
      }
    }
  });

  it("the copy tables and the outbox code sets cannot drift apart", () => {
    /*
     * Checked both ways, because each direction is a different bug: a code with no sentence would
     * put a raw enum in a family's SMS (renderTemplate refuses instead, which is why that refusal
     * is unreachable from enqueue — the outbox's own oneOf rule rejects a foreign code first), and a
     * sentence with no code is copy nothing can ever send, which goes stale unnoticed.
     */
    for (const [t, codes] of [["leg.canceled", LEG_CANCEL_REASON_CODES], ["center.closure", CLOSURE_REASON_CODES]] as const) {
      expect(Object.keys(outboundSms.reasons[t]).sort(), t).toEqual([...codes].sort());
    }
    // Defence in depth all the same: a code the copy table does not know is refused, not rendered.
    expect(() => renderTemplate("center.closure", { date: "2026-10-14", reasonCode: "NOT_A_CODE" })).toThrow(TemplateRenderError);
  });

  it("times and dates are worded, and the words do not depend on the server TZ", () => {
    expect(renderTemplate("therapist.absence_alert", { childFirstName: "Syn", sessionStart: "13:30" }))
      .toContain("The 1:30 PM session");
    // The same instant written with an offset renders the wall clock it was written in, not the server's.
    expect(renderTemplate("therapist.absence_alert", { childFirstName: "Syn", sessionStart: "2026-10-14T13:30:00-04:00" }))
      .toContain("The 1:30 PM session");
    expect(renderTemplate("center.closure", { date: "2026-10-14", reasonCode: "HOLIDAY" }))
      .toBe("PPEC: The center is closed on October 14. This is for a holiday. Reply HELP for help, STOP to opt out. [DEMO]");
    expect(renderTemplate("pickup.eta", { childFirstName: "Syn", eta: "00:05", stopLabel: "STOP-4" })).toContain("Pickup window 12:05 AM");
  });

  it("HELP is one fixed string with the opt-out word and no ride or child detail", () => {
    expect(renderTemplate(HELP_REPLY_TEMPLATE, {})).toBe(HELP_REPLY_BODY);
    expect(HELP_REPLY_BODY).toContain("Reply STOP to opt out.");
    expect(HELP_REPLY_BODY).toContain("(561) 555-0100");
  });

  it("generic.notice is fixed copy: it takes no vars at all (Veri #12)", () => {
    expect(templatePlaceholders("generic.notice")).toEqual([]);
    expect(() => renderTemplate("generic.notice", { text: "Mia is running late" })).toThrow(/not permitted/);
  });

  it("renders vars and refuses an unknown template, an unknown var, a bad value or a missing var", () => {
    expect(renderTemplate("pickup.eta", { childFirstName: "Mia", eta: "08:12", stopLabel: "OKEE-PARK" }))
      .toBe("PPEC: Mia's ride is on the way to OKEE-PARK. Pickup window 8:12 AM. Reply HELP for help, STOP to opt out. [DEMO]");
    expect(() => renderTemplate("not.a.template", {})).toThrow(TemplateRenderError);
    expect(() => renderTemplate("pickup.eta", { ...sampleVars("pickup.eta"), address: "1 Main St" })).toThrow(/not permitted/);
    // Free text in an allowlisted name is a value-rule refusal, and the value is never echoed back.
    const freeText = () => renderTemplate("pickup.eta", { ...sampleVars("pickup.eta"), stopLabel: "Okeeheelee Park" });
    expect(freeText).toThrow(/not permitted/);
    expect(freeText).not.toThrow(/Okeeheelee/);
    expect(() => renderTemplate("pickup.eta", { childFirstName: "Mia" })).toThrow(/needs var/);
  });
});
