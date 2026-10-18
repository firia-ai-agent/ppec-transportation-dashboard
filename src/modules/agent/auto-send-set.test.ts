/**
 * THE AUTO-SEND SET: what the day is allowed to text a family with nobody in the loop.
 *
 * Firia, 2026-10-17 11:00 PM ET (on Veri's S1-1): `dropoff.changed` and `leg.changed` come off
 * the agent's auto-send templates. Only `src/modules/approvals/decide.ts` sends those two, after
 * a director or a coordinator has approved. The one text that still goes out on its own is the
 * goal-3 late notice — a fixed template, no times in it, synthetic numbers only.
 *
 * Why the rule needs its own file rather than living only in `followup.test.ts`: the hole Veri
 * found was not in the executor, it was in a *list*. `FOLLOWUP_TEMPLATE_FAMILIES` (the schema the
 * model is handed) and `GUARDIAN_SEND_TEMPLATES` (the executor's allow-list) are two lists in two
 * modules, and the template only has to be on one of them for the send to become possible again.
 * So both are read here, by name, and the goal-3 notice is held to its two rules at the same time.
 *
 * Behaviour (the refusal itself, end to end on PGlite) is
 * `src/modules/agent/run/exec/followup.test.ts` "refuses to send {leg,dropoff}.changed".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { PEPPER, seedPersona } from "@/test/messaging";
import { freshDb, SITE } from "@/test/pglite";
import { ProviderRejected } from "@/modules/outbox/provider";
import { TEMPLATE_VARS } from "@/modules/outbox/outbox";
import { AUTO_SEND_TEMPLATES } from "@/modules/messaging/auto-sends";
import { renderTemplate } from "@/modules/messaging/templates";
import { etaNoticeTemplate } from "@/modules/messaging/eta-notice";
import { DbSimMessagingProvider } from "@/modules/messaging/sim-provider";
import { SIM_PERSONA_NUMBERS } from "@/modules/messaging/sim-numbers";
import { FOLLOWUP_TEMPLATE_FAMILIES, FOLLOWUP_TEMPLATE_IDS } from "./tools";
import { GUARDIAN_SEND_TEMPLATES } from "./run/exec/followup";

/** The two bodies that tell a family their child's ride is different. A person signs these. */
const APPROVAL_ONLY = ["dropoff.changed", "leg.changed"] as const;

/** The goal-3 automatic text: the afternoon van that has lost time (PRD §18.2 step 7). */
const LATE_NOTICE = "dropoff.late";

/**
 * A clock time in any shape a body could carry one: "5:15 PM", "17:15", "5pm", "5:15".
 * The COPY RULE (Firia, 2026-10-18 12:17 AM ET) is that a drafted or automatic family text
 * carries none.
 */
const CLOCK_TIME = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?[ap]\.?m\.?/i;

describe("the agent's auto-send lists do not contain the two approval-only bodies (Firia 11:00 PM ET)", () => {
  it("is off the tool schema the model is given", () => {
    for (const templateId of APPROVAL_ONLY) {
      expect(
        FOLLOWUP_TEMPLATE_IDS,
        `${templateId} is back on send_followup's schema — the model can ask for it again`,
      ).not.toContain(templateId);
    }
    // And specifically off the `confirmation` family, which is where both of them were.
    expect(FOLLOWUP_TEMPLATE_FAMILIES.confirmation).toEqual(["leg.canceled"]);
  });

  it("is off the executor's guardian allow-list, which is the second lock", () => {
    for (const templateId of APPROVAL_ONLY) {
      expect(
        GUARDIAN_SEND_TEMPLATES,
        `${templateId} is back on AUDIENCE_RULES.GUARDIAN_OF_CHILD — send_followup would queue it`,
      ).not.toContain(templateId);
    }
  });

  it("is still a real template, because approvals/decide.ts sends it", () => {
    // The ruling moved *who* sends these, not whether they exist. A body the outbox no longer
    // knew would break the approval path instead of the agent path.
    for (const templateId of APPROVAL_ONLY) {
      expect(Object.keys(TEMPLATE_VARS)).toContain(templateId);
    }
  });

  it("is never labelled 'Auto' in a thread either", () => {
    // `auto-sends.ts` is the UI's claim about who sent a bubble. An approved reply is a person's.
    for (const templateId of APPROVAL_ONLY) {
      expect(AUTO_SEND_TEMPLATES.has(templateId)).toBe(false);
    }
  });
});

describe("the goal-3 late notice is the one automatic text, and it carries no time", () => {
  it("is the afternoon's template, and it is on the auto-send list", () => {
    expect(etaNoticeTemplate("PM")).toBe(LATE_NOTICE);
    expect(AUTO_SEND_TEMPLATES.has(LATE_NOTICE)).toBe(true);
  });

  it("permits no eta and no etaEnd, so a caller cannot put one back", () => {
    // The allow-list is the enforcement: a var the template does not permit is refused at
    // enqueue (Firia, 2026-10-17 10:51 PM ET, "no time range and no ETA").
    expect(Object.keys(TEMPLATE_VARS[LATE_NOTICE]).sort()).toEqual(["delayMinutes", "stopLabel"]);
  });

  it("renders with no clock time in it at all", () => {
    const body = renderTemplate(LATE_NOTICE, { stopLabel: "OKEE-PARK", delayMinutes: 15 });
    expect(body, `the late notice has a clock time in it: ${body}`).not.toMatch(CLOCK_TIME);
    // It still says the thing it is for: minutes a family can act on, and where the stop is.
    expect(body).toContain("15 minutes late");
    expect(body).toContain("Okeeheelee Park");
  });
});

describe("the late notice goes to a synthetic number or nowhere (MOCKS §3)", () => {
  let pg: PGlite;
  let db: Db;

  beforeEach(async () => {
    ({ pg, db } = await freshDb());
  });
  afterEach(async () => {
    await pg.close();
  });

  const provider = () =>
    new DbSimMessagingProvider(db, { schedule: async () => {} } as never, { pepper: PEPPER });

  const lateNotice = (recipientToken: string) => ({
    messageId: "00000000-0000-7000-8000-00000000e101",
    siteId: SITE,
    idempotencyKey: "late-notice-1",
    channel: "SMS_1TO1",
    recipientToken,
    templateId: LATE_NOTICE,
    vars: { stopLabel: "OKEE-PARK", delayMinutes: 15 },
    childToken: null,
  });

  it("sends to a persona phone", async () => {
    const persona = await seedPersona(db, SIM_PERSONA_NUMBERS[3], { siteId: SITE, now: TEST_NOW });
    const answer = await provider().send(lateNotice(persona.contactToken), {
      signal: new AbortController().signal,
    });
    expect(answer.providerMessageId).toContain("SIM-");
  });

  it("refuses a family contact on a number the fiction block does not hold, and writes nothing", async () => {
    const persona = await seedPersona(db, SIM_PERSONA_NUMBERS[4], { siteId: SITE, now: TEST_NOW });
    // The same contact, re-pointed at a number outside 555-01xx. Everything else is unchanged,
    // so the refusal is about the number.
    await db.query("UPDATE identity.guardian_contact SET phone_hmac = $1 WHERE contact_token = $2", [
      "not-a-persona-blind-index",
      persona.contactToken,
    ]);
    await expect(
      provider().send(lateNotice(persona.contactToken), { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    const rows = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ops.message", []);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});
