import { describe, expect, it } from "vitest";
import { TEMPLATE_VARS } from "@/modules/outbox/outbox";
import { HELP_REPLY_BODY, HELP_REPLY_TEMPLATE, knownTemplates, renderTemplate, templatePlaceholders, TemplateRenderError } from "./templates";

describe("outbound SMS templates (COPY-GUIDE §5)", () => {
  it("every outbox template has a body and every placeholder is an allowlisted var", () => {
    expect(knownTemplates().sort()).toEqual(Object.keys(TEMPLATE_VARS).sort());
    for (const t of knownTemplates()) {
      for (const v of templatePlaceholders(t)) expect(TEMPLATE_VARS[t].has(v), `${t} uses ${v}`).toBe(true);
    }
  });

  it("no ticket codes, enum names, emoji or banned words reach a family (COPY-GUIDE §2)", () => {
    for (const t of knownTemplates()) {
      const body = renderTemplate(t, Object.fromEntries([...TEMPLATE_VARS[t]].map((v) => [v, "SYN"])));
      expect(body, t).not.toMatch(/\b(?:MSG|NTF|PPE|AT|ADR|PRD|CQ|VEH|TRP|LOC|AGT|RES)-\d/i);
      expect(body, t).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/); // enum names stay on developer surfaces
      expect(body, t).not.toMatch(/\b(?:load|unload|cargo|pax|patient|handicapped|ASAP|URGENT)\b/i);
      expect(body, t).not.toMatch(/wheelchair-bound|special needs|[\u{1F300}-\u{1FAFF}]|!/u);
      expect(body, t).toContain("[DEMO]"); // COPY-GUIDE §6: a simulated message says so
      expect(body, t).toMatch(/^PPEC: /);
    }
  });

  it("HELP is one fixed string with the opt-out word and no ride or child detail", () => {
    expect(renderTemplate(HELP_REPLY_TEMPLATE, {})).toBe(HELP_REPLY_BODY);
    expect(HELP_REPLY_BODY).toContain("Reply STOP to opt out.");
    expect(HELP_REPLY_BODY).toContain("(561) 555-0100");
  });

  it("renders vars and refuses an unknown template, an unknown var or a missing var", () => {
    expect(renderTemplate("pickup.eta", { childFirstName: "Mia", eta: "8:12-8:22 AM", stopLabel: "Okeeheelee Park" }))
      .toBe("PPEC: Mia's ride is on the way to Okeeheelee Park. Pickup window 8:12-8:22 AM. Reply HELP for help, STOP to opt out. [DEMO]");
    expect(() => renderTemplate("not.a.template", {})).toThrow(TemplateRenderError);
    expect(() => renderTemplate("pickup.eta", { childFirstName: "Mia", eta: "x", stopLabel: "y", address: "1 Main St" })).toThrow(/not permitted/);
    expect(() => renderTemplate("pickup.eta", { childFirstName: "Mia" })).toThrow(/needs var/);
  });
});
