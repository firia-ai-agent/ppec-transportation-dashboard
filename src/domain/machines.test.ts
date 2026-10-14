import { describe, expect, it } from "vitest";
import { ACTORS, canTransition, MACHINES, LEG, TASK, CAPABILITY, ATTENDANCE, OUTBOUND, type Machine } from "./machines";

// DATA-MODEL.md §4 rule: every listed edge succeeds for its actor; every unlisted pair and wrong actor is rejected.
describe.each(Object.entries(MACHINES))("%s", (_name, m) => {
  const mm = m as Machine<string>;
  const listed = (f: string, t: string, a: string) =>
    mm.edges.some((e) => (e.from === f || (e.from === "*" && f !== e.to)) && e.to === t && (e.by as string[]).includes(a));
  it("edges reference only real states", () => {
    for (const e of mm.edges) {
      if (e.from !== "*") expect(mm.states).toContain(e.from);
      expect(mm.states).toContain(e.to);
      expect(e.by.length).toBeGreaterThan(0);
    }
  });
  it("legal edges pass for their actors; every other (from, to, actor) is rejected", () => {
    let legal = 0;
    for (const f of mm.states) for (const t of mm.states) for (const a of ACTORS) {
      if (mm === (LEG as unknown as Machine<string>) && f === "EXCEPTION") continue; // covered below
      const ok = canTransition(mm, f, t, a);
      expect(ok, `${f}->${t} by ${a}`).toBe(listed(f, t, a) && f !== t);
      if (ok) legal++;
    }
    expect(legal).toBeGreaterThan(0);
  });
  it("self-loops are never allowed", () => {
    for (const s of mm.states) for (const a of ACTORS) expect(canTransition(mm, s, s, a)).toBe(false);
  });
});

describe("golden cases (PRD §6.3)", () => {
  it("agent can never verify capability or boarding", () => {
    expect(canTransition(LEG, "CAPABILITY_REPORTED", "CAPABILITY_VERIFIED", "A")).toBe(false);
    expect(canTransition(LEG, "BOARDED_REPORTED", "BOARDED_VERIFIED", "A")).toBe(false);
    expect(canTransition(CAPABILITY, "REPORTED", "VERIFIED", "A")).toBe(false);
  });
  it("no cancel after boarding (AT-07)", () => {
    for (const a of ACTORS) {
      expect(canTransition(LEG, "BOARDED_VERIFIED", "CANCELED_TRANSPORT", a)).toBe(false);
      expect(canTransition(LEG, "IN_TRANSIT", "CANCELED_ATTENDANCE", a)).toBe(false);
    }
  });
  it("HELD_NO_RECEIVER exits by staff only, no automatic return (AT-13)", () => {
    expect(canTransition(LEG, "ARRIVED_DROPOFF", "HELD_NO_RECEIVER", "Y")).toBe(true);
    expect(canTransition(LEG, "HELD_NO_RECEIVER", "COMPLETED_HANDOFF", "S")).toBe(true);
    for (const a of ["Y", "A", "G", "P"] as const) expect(canTransition(LEG, "HELD_NO_RECEIVER", "COMPLETED_HANDOFF", a)).toBe(false);
    expect(canTransition(LEG, "HELD_NO_RECEIVER", "SCHEDULED", "Y")).toBe(false);
  });
  it("EXCEPTION returns only to stored prior state, by staff", () => {
    expect(canTransition(LEG, "EXCEPTION", "IN_TRANSIT", "S", { priorState: "IN_TRANSIT" })).toBe(true);
    expect(canTransition(LEG, "EXCEPTION", "COMPLETED_HANDOFF", "S", { priorState: "IN_TRANSIT" })).toBe(false);
    expect(canTransition(LEG, "EXCEPTION", "IN_TRANSIT", "Y", { priorState: "IN_TRANSIT" })).toBe(false);
    expect(canTransition(LEG, "EXCEPTION", "IN_TRANSIT", "S")).toBe(false);
  });
  it("full-day absence only before check-in; leg-level cancel is separate (AT-07)", () => {
    expect(canTransition(ATTENDANCE, "SCHEDULED", "ABSENT_FULL_DAY", "A")).toBe(true);
    expect(canTransition(ATTENDANCE, "CHECKED_IN", "ABSENT_FULL_DAY", "S")).toBe(false);
  });
  it("task close is system-only; outbound never resends from UNKNOWN", () => {
    expect(canTransition(TASK, "RESOLVED_APPROVED", "CLOSED_VERIFIED", "S")).toBe(false);
    expect(canTransition(TASK, "RESOLVED_APPROVED", "CLOSED_VERIFIED", "Y")).toBe(true);
    for (const t of OUTBOUND.states) for (const a of ACTORS) expect(canTransition(OUTBOUND, "UNKNOWN", t, a)).toBe(false);
  });
  it("golden legal-edge counts (catches accidental table edits)", () => {
    const count = (m: Machine<string>) => {
      let n = 0;
      for (const f of m.states) for (const t of m.states) if (f !== t && ACTORS.some((a) => canTransition(m, f, t, a))) n++;
      return n;
    };
    expect(count(MACHINES.ATTENDANCE as unknown as Machine<string>)).toBe(9);
    expect(count(MACHINES.ACK as unknown as Machine<string>)).toBe(4);
    expect(count(MACHINES.TASK as unknown as Machine<string>)).toBe(9);
    expect(count(MACHINES.THREAD as unknown as Machine<string>)).toBe(4);
    expect(count(MACHINES.PROFILE as unknown as Machine<string>)).toBe(2);
    expect(count(MACHINES.NEED_ITEM as unknown as Machine<string>)).toBe(3);
    expect(count(MACHINES.OUTBOUND as unknown as Machine<string>)).toBe(13);
    expect(count(MACHINES.RESERVATION as unknown as Machine<string>)).toBe(9);
    expect(count(MACHINES.CAPABILITY as unknown as Machine<string>)).toBe(14);
  });
});
