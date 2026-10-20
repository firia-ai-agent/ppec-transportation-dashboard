import { describe, expect, it } from "vitest";
import type { PersonaMessage } from "@/modules/messaging/mailbox";
import { familyTexts } from "@/ui/copy";
import { bubbleOf } from "./thread";

const inbound = (triage: string | null): PersonaMessage => ({
  id: "m1", direction: "IN", at: "2026-10-19T20:00:00.000Z", body: "thanks!", state: null, templateId: null,
  reachedPhone: true, blockReason: null, providerMessageId: "SIM-1", providerIndex: null, sourceMode: "SIMULATED", triage,
});

describe("a family's text says what triage made of it (ledger #85, SURF-03)", () => {
  it("notes FYI and NOISE under the bubble, so a coordinator sees why no card came", () => {
    expect(bubbleOf(inbound("FYI")).triage).toBe("FYI");
    expect(bubbleOf(inbound("NOISE")).triage).toBe("NOISE");
    expect(familyTexts.triage.FYI).toBe("FYI · nothing to change");
  });

  it("says nothing for a text the full agent took, an untriaged one, or anything we sent", () => {
    expect(bubbleOf(inbound("PLAN_TODAY")).triage).toBeUndefined();
    expect(bubbleOf(inbound(null)).triage).toBeUndefined();
    expect(bubbleOf({ ...inbound("FYI"), direction: "OUT", state: "SENT", templateId: "dropoff.changed" }).triage).toBeUndefined();
  });
});
