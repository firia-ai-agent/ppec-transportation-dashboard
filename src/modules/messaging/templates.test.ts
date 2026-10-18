import { describe, expect, it } from "vitest";
import { CHILDREN, EXTERNAL_PEOPLE, FAMILIES, STOPS } from "@/modules/demo/fixtures/standard";
import { CLOSURE_REASON_CODES, LEG_CANCEL_REASON_CODES, TEMPLATE_VARS } from "@/modules/outbox/outbox";
import { outboundSms } from "@/ui/copy";
import { HELP_REPLY_BODY, HELP_REPLY_TEMPLATE, knownTemplates, renderTemplate, templatePlaceholders, TemplateRenderError, UNKNOWN_STOP } from "./templates";

/**
 * One rule-abiding value per var name (outbox TEMPLATE_VARS value rules, Veri #12). Since those
 * rules reject free text, a sample that "looks like" copy is no longer usable: a stop is a token, a
 * time is HH:MM, a reason is a code.
 */
const SAMPLE: Record<string, string> = {
  stopLabel: "OKEE-PARK",
  eta: "08:12",
  etaEnd: "08:22",
  sessionStart: "13:30",
  legDate: "2026-10-14",
  date: "2026-10-14",
  delayMinutes: "15",
};
const sampleVars = (templateId: string, reasonCode = "WEATHER"): Record<string, string> =>
  Object.fromEntries(Object.keys(TEMPLATE_VARS[templateId]).map((v) => [v, v === "reasonCode" ? reasonCode : SAMPLE[v]]));

describe("outbound SMS templates (COPY-GUIDE §5)", () => {
  it("every outbox template has a body and every placeholder is an allowlisted var", () => {
    expect(knownTemplates().sort()).toEqual(Object.keys(TEMPLATE_VARS).sort());
    for (const t of knownTemplates()) {
      /*
       * `childName` is the one placeholder that is not a var and must never become one: it is
       * resolved at render time from the child's own row (`RenderFor`, Firia 2026-10-17 10:51 PM
       * ET), the way `{optOut}` and `{demoTag}` are folded in. The assertion below is the door:
       * no template's allowlist may carry it.
       */
      for (const v of templatePlaceholders(t).filter((v) => v !== "childName")) {
        expect(Object.hasOwn(TEMPLATE_VARS[t], v), `${t} uses ${v}`).toBe(true);
      }
      expect(Object.keys(TEMPLATE_VARS[t]), t).not.toContain("childName");
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
    expect(renderTemplate("therapist.absence_alert", { sessionStart: "13:30" }))
      .toContain("The 1:30 PM session");
    // The same instant written with an offset renders the wall clock it was written in, not the server's.
    expect(renderTemplate("therapist.absence_alert", { sessionStart: "2026-10-14T13:30:00-04:00" }))
      .toContain("The 1:30 PM session");
    expect(renderTemplate("center.closure", { date: "2026-10-14", reasonCode: "HOLIDAY" }))
      .toBe("PPEC: The center is closed on October 14. This is for a holiday. Reply HELP for help, STOP to opt out. [DEMO]");
    expect(renderTemplate("pickup.eta", { eta: "00:05", stopLabel: "OKEE-PARK" })).toContain("Pickup around 12:05 AM");
    // Both ends of a window are read from their own text too, so neither moves with the server TZ.
    expect(renderTemplate("pickup.eta", { eta: "2026-10-14T08:12:00-04:00", etaEnd: "2026-10-14T08:22:00-04:00", stopLabel: "OKEE-PARK" }))
      .toContain("Pickup 8:12\u20138:22 AM");
  });

  it("HELP is one fixed string with the opt-out word and no van or child detail", () => {
    expect(renderTemplate(HELP_REPLY_TEMPLATE, {})).toBe(HELP_REPLY_BODY);
    expect(HELP_REPLY_BODY).toContain("Reply STOP to opt out.");
    expect(HELP_REPLY_BODY).toContain("(561) 555-0100");
  });

  it("generic.notice is fixed copy: it takes no vars at all (Veri #12)", () => {
    expect(templatePlaceholders("generic.notice")).toEqual([]);
    expect(() => renderTemplate("generic.notice", { text: "Mia is running late" })).toThrow(/not permitted/);
  });

  it("renders vars and refuses an unknown template, an unknown var, a bad value or a missing var", () => {
    expect(renderTemplate("pickup.eta", { eta: "08:12", etaEnd: "08:22", stopLabel: "OKEE-PARK" }))
      .toBe("PPEC: Your child's van is on the way to Okeeheelee Park. Pickup 8:12\u20138:22 AM. Reply HELP for help, STOP to opt out. [DEMO]");
    expect(() => renderTemplate("not.a.template", {})).toThrow(TemplateRenderError);
    expect(() => renderTemplate("pickup.eta", { ...sampleVars("pickup.eta"), address: "1 Main St" })).toThrow(/not permitted/);
    // Free text in an allowlisted name is a value-rule refusal, and the value is never echoed back.
    const freeText = () => renderTemplate("pickup.eta", { ...sampleVars("pickup.eta"), stopLabel: "Okeeheelee Park" });
    expect(freeText).toThrow(/not permitted/);
    expect(freeText).not.toThrow(/Okeeheelee/);
    expect(() => renderTemplate("pickup.eta", { stopLabel: "OKEE-PARK" })).toThrow(/needs var/);
  });
});

/**
 * The two things a family reads a van message for: where the stop is, and when the van comes.
 * Both are rendered from constrained vars (a short token, one or two clock times) — the outbox's
 * no-free-text rule is untouched, and the names come only from the fixed table in copy.ts.
 */
describe("the stop a family reads (copy.ts stops table)", () => {
  const pickup = (stopLabel: string) => renderTemplate("pickup.eta", { ...sampleVars("pickup.eta"), stopLabel });

  it("a known token becomes the public place it names, never the token", () => {
    expect(pickup("OKEE-PARK")).toContain("on the way to Okeeheelee Park.");
    expect(pickup("OKEE-PARK")).not.toContain("OKEE-PARK");
    expect(pickup("PBSC-LW")).toContain("on the way to Palm Beach State College, Lake Worth.");
    // The center names itself and not its street address (COPY-GUIDE §5: never addresses).
    expect(pickup("CENTER")).toContain("on the way to the PPEC center.");
    expect(pickup("CENTER")).not.toMatch(/\d+ Jog Rd/);
  });

  it("an unknown token becomes \"your usual stop\", and the token is not in the message", () => {
    // All four pass the outbox's stopToken rule; none of them is a place this release knows.
    for (const token of ["STOP-4", "S2", "NEW-STOP", "OKEE-PARK2"]) {
      const body = pickup(token);
      expect(body, token).toContain(`on the way to ${UNKNOWN_STOP}.`);
      expect(body, token).not.toContain(token);
    }
    expect(UNKNOWN_STOP).toBe("your usual stop");
  });

  it("every stop token a message can carry has a place name, on every template that names a stop", () => {
    for (const t of knownTemplates().filter((t) => templatePlaceholders(t).includes("stopLabel"))) {
      for (const token of Object.keys(outboundSms.stops)) {
        const body = renderTemplate(t, { ...sampleVars(t), stopLabel: token });
        expect(body, `${t}/${token}`).toContain(outboundSms.stops[token as keyof typeof outboundSms.stops]);
        expect(body, `${t}/${token}`).not.toContain(token);
      }
    }
  });

  it("the table and the demo stops cannot drift apart: every fixture stop has family copy", () => {
    for (const stop of STOPS) {
      const name = outboundSms.stops[stop.smsToken as keyof typeof outboundSms.stops];
      expect(name, `${stop.key} (${stop.smsToken})`).toBeTruthy();
      // The center is the one stop whose fixture label carries a street address; its copy drops it.
      if (stop.key !== "CENTER") expect(name, stop.key).toBe(stop.label);
    }
    expect(new Set(STOPS.map((s) => s.smsToken)).size).toBe(STOPS.length);
  });
});

describe("the pickup window (etaEnd, COPY-GUIDE §3)", () => {
  const pickup = (eta: string, etaEnd?: string) =>
    renderTemplate("pickup.eta", { stopLabel: "OKEE-PARK", eta, ...(etaEnd ? { etaEnd } : {}) });

  it("both ends present read as one window, with the AM/PM said once", () => {
    expect(pickup("08:12", "08:22")).toContain("Pickup 8:12–8:22 AM.");
    expect(pickup("15:05", "15:20")).toContain("Pickup 3:05–3:20 PM.");
    // Across noon the half is said on both ends, or the window reads as 11:50 to 12:10 in one half.
    expect(pickup("11:50", "12:10")).toContain("Pickup 11:50 AM–12:10 PM.");
  });

  it("one time alone reads as an estimate, not as a promise of the minute", () => {
    expect(pickup("08:15")).toContain("Pickup around 8:15 AM.");
    // A window of no width is that same one time, not "8:15-8:15 AM".
    expect(pickup("08:15", "08:15")).toContain("Pickup around 8:15 AM.");
  });

  it("the window is rendered on each template that takes one, and only as a window", () => {
    expect(renderTemplate("dropoff.eta", { stopLabel: "PRINCE-PARK", eta: "16:05", etaEnd: "16:20" }))
      .toBe("PPEC: Your child's van home is on the way to John Prince Park. Arrival 4:05–4:20 PM. Reply HELP for help, STOP to opt out. [DEMO]");
    expect(renderTemplate("leg.changed", { legDate: "2026-10-14", stopLabel: "OKEE-PARK", eta: "08:12", etaEnd: "08:22" }))
      .toBe("PPEC: Your child's van on October 14 changed. New pickup 8:12–8:22 AM at Okeeheelee Park. Reply HELP for help, STOP to opt out. [DEMO]");
    // etaEnd is read by the eta rule, so no body needs a placeholder of its own for it.
    for (const t of knownTemplates()) expect(templatePlaceholders(t), t).not.toContain("etaEnd");
  });

  it("a time a template records rather than estimates is still the exact time", () => {
    // These two have no etaEnd var: the time is what happened, so it is not hedged with "around".
    expect(renderTemplate("child.not_received", { stopLabel: "OKEE-PARK", eta: "08:30" }))
      .toContain("at Okeeheelee Park at 8:30 AM.");
    expect(renderTemplate("therapist.late_alert", { sessionStart: "13:30", eta: "13:45" }))
      .toContain("Now expected 1:45 PM.");
  });

  it("an end before the start is refused, not sent backwards", () => {
    expect(() => pickup("08:22", "08:12")).toThrow(TemplateRenderError);
    expect(() => pickup("08:22", "08:12")).toThrow(/no copy for var eta/);
  });

  it("etaEnd is a clock time like eta: free text in it is refused, and never echoed", () => {
    const freeText = () => pickup("08:12", "a bit after Mia's nap");
    expect(freeText).toThrow(/not permitted/);
    expect(freeText).not.toThrow(/Mia's nap/);
    expect(() => pickup("08:12", "8:22")).toThrow(/not permitted/); // HH:MM, not H:MM
    // The templates that do not take a window do not accept the var either.
    expect(() => renderTemplate("child.not_received", { stopLabel: "OKEE-PARK", eta: "08:30", etaEnd: "08:40" }))
      .toThrow(/not permitted/);
  });
});

/**
 * No child's name in an outbound SMS, under any template (the rule the outbox enforces on the var
 * side, checked here on the words side). A name identifies the child to whoever is holding the
 * phone, and the bodies say "your child" / "a child" instead, so there is nothing left to leak.
 */
/** Every first name the demo seed can put on the board: children, their guardians, the externals. */
const SEEDED_FIRST_NAMES = [
  ...CHILDREN.map((c) => c.firstName),
  ...FAMILIES.map((f) => f.guardian.firstName),
  ...EXTERNAL_PEOPLE.map((e) => e.firstName),
];

/**
 * The seeded names a body carries. Word-bounded, so "Ava" does not match inside "available" — a
 * name is a word, not a substring. Module-level because two describes need it: the sweep over
 * every template below, and the one body Vera wrote out by hand at the end of this file.
 */
function namesInBody(body: string): string[] {
  return [...new Set(SEEDED_FIRST_NAMES.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(body)))];
}

describe("no child's name reaches a rendered body", () => {
  const namesIn = namesInBody;

  /**
   * **No name is ever a var** — and since Firia's 10:51 PM ET ruling of 2026-10-17 that is the
   * whole of the Veri #12 name rule, rather than "no body names a child".
   *
   * The ruling is that the text a family gets is human and names the child ("Yes, Jonah gets off
   * at … at 3:58 PM"). What Veri #12 was protecting against is a *name a caller chose*: a
   * staff-typed or model-written value in `vars`, which no value-shape check can tell from a
   * nickname or a typo. That door is still shut, and this test is the lock on it:
   *
   *  - no template's allowlist carries a name var, under any spelling;
   *  - the only name placeholder is `{childName}`, which `renderTemplate` resolves from the
   *    child's own `ops.child_profile.display_name` — never from `vars`, which it does not even
   *    look in for it;
   *  - with no row to read, the body says "your child" and still sends.
   */
  it("carries no name var, under any spelling: the name is read from the child's row", () => {
    for (const t of knownTemplates()) {
      for (const v of Object.keys(TEMPLATE_VARS[t])) expect(v, `${t} allows ${v}`).not.toMatch(/name/i);
      for (const v of templatePlaceholders(t)) {
        expect(v === "childName" || !/name/i.test(v), `${t} uses ${v}`).toBe(true);
      }
    }
    expect(JSON.stringify(outboundSms.bodies) + outboundSms.helpReply).not.toContain("childFirstName");
  });

  it("names the child the row names, and nobody when there is no row", () => {
    const vars = sampleVars("dropoff.changed");
    // The name comes from the third argument — the server's read of the child's row — and the
    // vars it is rendered with carry no name at all.
    expect(renderTemplate("dropoff.changed", vars, { child: "Jonah W." })).toContain("Jonah gets off at");
    expect(JSON.stringify(vars)).not.toContain("Jonah");
    // A `vars` entry cannot put a name in: it is refused as a var the template does not permit.
    expect(() => renderTemplate("dropoff.changed", { ...vars, childName: "Mallory" })).toThrow();
    // And with no row read, the body is the wording every body carried before the ruling.
    expect(renderTemplate("dropoff.changed", vars)).toContain("your child gets off at");
  });

  it("no seeded first name appears in any rendered body, on any template or stop or reason", () => {
    const rendered = [HELP_REPLY_BODY];
    for (const t of knownTemplates()) {
      rendered.push(renderTemplate(t, sampleVars(t)));
      for (const code of t === "center.closure" ? [...CLOSURE_REASON_CODES] : t === "leg.canceled" ? [...LEG_CANCEL_REASON_CODES] : []) {
        rendered.push(renderTemplate(t, sampleVars(t, code)));
      }
      if (templatePlaceholders(t).includes("stopLabel")) {
        for (const token of [...Object.keys(outboundSms.stops), "NEW-STOP"]) rendered.push(renderTemplate(t, { ...sampleVars(t), stopLabel: token }));
      }
    }
    expect(rendered.length).toBeGreaterThan(knownTemplates().length);
    for (const body of rendered) expect(namesIn(body), body).toEqual([]);
    // The scan itself works: a name in a body would be caught.
    expect(namesIn(`PPEC: ${CHILDREN[0].firstName}'s van is on the way.`)).toEqual([CHILDREN[0].firstName]);
  });

  it("a name passed as a var is refused, not rendered, and never echoed back", () => {
    for (const t of knownTemplates()) {
      const withName = () => renderTemplate(t, { ...sampleVars(t), childFirstName: "Mia" });
      expect(withName, t).toThrow(/not permitted/);
      expect(withName, t).not.toThrow(/Mia/);
    }
  });

  it("every placeholder has a display rule, and one without it would be refused, not printed raw", () => {
    // Since no var renders as itself any more, a var added to a body with no FORMAT entry is a
    // refusal rather than a developer-facing value (a code, a token, a 24h clock) in a family's SMS.
    for (const t of knownTemplates()) expect(() => renderTemplate(t, sampleVars(t)), t).not.toThrow(/no display rule/);
  });
});

/**
 * VERA'S LATE TEXT, VERBATIM (2026-10-17 12:59 PM ET).
 *
 * This is the one body a founder reads out loud, so its words are a decision rather than a
 * detail — and they were reworded. The old one opened "Your child's van home", which makes a
 * parent parse a compound noun before they get to the news; the new one opens with the van and
 * what it is doing. Pinned here so a later edit to the template is a deliberate change with
 * Vera's name on it rather than a drift nobody noticed.
 */
describe("the late drop-off text says what Vera settled", () => {
  const TEMPLATE = "dropoff.late";

  /*
   * Vera's sentence, as Firia's 2026-10-17 10:51 PM ET ruling leaves it: "the auto late text has
   * no time range and no ETA". The news is the news — how late the van is, in minutes a person
   * can act on — and the stop the family is already going to. Nothing a family could read as a
   * promised arrival, and the next thing they get is the arrival notice itself.
   */
  it("is her sentence, word for word, before the standard tail", () => {
    expect(outboundSms.bodies[TEMPLATE]).toContain(
      "PPEC: {childName}'s van home is running about {delayMinutes} minutes late. The drop-off is still at {stopLabel}.",
    );
  });

  it("carries no time at all: not a window, not a single ETA", () => {
    const body = renderTemplate(TEMPLATE, { delayMinutes: 15, stopLabel: "OKEE-PARK" }, { child: "Noah O." });

    expect(body).toContain("about 15 minutes late");
    expect(body).toContain("Okeeheelee Park");
    // No clock time of any kind, in either form, and no range.
    expect(body).not.toMatch(/\d{1,2}:\d{2}/);
    expect(body).not.toContain("\u2013");
    // The allowlist is the enforcement: a caller cannot put a time back in.
    expect(Object.keys(TEMPLATE_VARS[TEMPLATE])).toEqual(["stopLabel", "delayMinutes"]);
    expect(() => renderTemplate(TEMPLATE, { delayMinutes: 15, stopLabel: "OKEE-PARK", eta: "16:35" })).toThrow();
  });

  it("names the child whose van it is (Firia, 10:51 PM ET)", () => {
    const body = renderTemplate(TEMPLATE, { delayMinutes: 15, stopLabel: "OKEE-PARK" }, { child: "Noah O." });
    expect(body).toContain("Noah's van home");
    // And with no row read it is the old wording, which still names nobody.
    expect(namesInBody(renderTemplate(TEMPLATE, { delayMinutes: 15, stopLabel: "OKEE-PARK" }))).toEqual([]);
  });
});
