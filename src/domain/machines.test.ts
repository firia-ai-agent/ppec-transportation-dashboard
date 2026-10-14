import { describe, expect, it } from "vitest";
import { ACTORS, canTransition, wildcardApplies, MACHINES, LEG, TASK, CAPABILITY, ATTENDANCE, OUTBOUND, ACK, RESERVATION, type Machine } from "./machines";

// DATA-MODEL.md §4 rule: every listed edge succeeds for its actor; every unlisted pair and wrong actor is rejected.
describe.each(Object.entries(MACHINES))("%s", (_name, m) => {
  const mm = m as Machine<string>;
  const listed = (f: string, t: string, a: string) =>
    !mm.terminal.includes(f) &&
    mm.edges.some((e) => (e.from === f || (e.from === "*" && wildcardApplies(mm, f, e.to))) && e.to === t && (e.by as string[]).includes(a) &&
      !(a === "A" && e.agentRequiresVerifiedGuardian));
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
  it("terminal states never reopen, for any target, actor or context", () => {
    for (const f of mm.terminal) for (const t of mm.states) for (const a of ACTORS) {
      expect(canTransition(mm, f, t, a, { priorState: t, verifiedUnambiguousGuardian: true }), `${f}->${t} by ${a}`).toBe(false);
    }
  });
  it("self-loops are never allowed", () => {
    for (const s of mm.states) for (const a of ACTORS) expect(canTransition(mm, s, s, a)).toBe(false);
  });
});

describe("golden cases (PRD §6.3)", () => {
  it("EXCEPTION cannot be entered from terminal or staff-exit-only leg states, even by Y/A", () => {
    for (const f of ["COMPLETED_HANDOFF", "CANCELED_TRANSPORT", "CANCELED_ATTENDANCE", "NO_SHOW", "HELD_NO_RECEIVER", "LEFT_BEHIND_CAPACITY"] as const)
      for (const a of ACTORS) expect(canTransition(LEG, f, "EXCEPTION", a), `${f} by ${a}`).toBe(false);
    expect(canTransition(LEG, "IN_TRANSIT", "EXCEPTION", "A")).toBe(true);
    expect(canTransition(LEG, "EXCEPTION", "COMPLETED_HANDOFF", "S", { priorState: "COMPLETED_HANDOFF" })).toBe(false);
  });
  it("NEEDS_REVIEW and CHANGED are not reachable from terminal states", () => {
    for (const f of ["RELEASED", "INFEASIBLE"] as const) expect(canTransition(RESERVATION, f, "NEEDS_REVIEW", "Y")).toBe(false);
    expect(canTransition(RESERVATION, "COMMITTED", "NEEDS_REVIEW", "Y")).toBe(true);
    for (const f of ["REJECTED", "UNAVAILABLE", "VERIFIED_INFEASIBLE"] as const) for (const a of ACTORS) expect(canTransition(CAPABILITY, f, "CHANGED", a)).toBe(false);
    expect(canTransition(CAPABILITY, "VERIFIED", "CHANGED", "P")).toBe(true);
  });
  it("LEFT_BEHIND_CAPACITY has staff-only exits (PRD l.750)", () => {
    expect(canTransition(LEG, "LEFT_BEHIND_CAPACITY", "PROVISIONAL_ASSIGNED", "S")).toBe(true);
    expect(canTransition(LEG, "LEFT_BEHIND_CAPACITY", "CANCELED_TRANSPORT", "S")).toBe(true);
    for (const a of ["Y", "A", "P", "G", "T"] as const) {
      expect(canTransition(LEG, "LEFT_BEHIND_CAPACITY", "PROVISIONAL_ASSIGNED", a)).toBe(false);
      expect(canTransition(LEG, "LEFT_BEHIND_CAPACITY", "CANCELED_TRANSPORT", a)).toBe(false);
    }
  });
  it("agent cancel needs a verified unambiguous guardian, pre-boarding only", () => {
    expect(canTransition(LEG, "MANIFEST_LOCKED", "CANCELED_TRANSPORT", "A")).toBe(false);
    expect(canTransition(LEG, "MANIFEST_LOCKED", "CANCELED_TRANSPORT", "A", { verifiedUnambiguousGuardian: true })).toBe(true);
    expect(canTransition(LEG, "MANIFEST_LOCKED", "CANCELED_TRANSPORT", "S")).toBe(true);
    expect(canTransition(LEG, "BOARDED_REPORTED", "CANCELED_TRANSPORT", "A", { verifiedUnambiguousGuardian: true })).toBe(false);
  });
  it("outbound UNKNOWN follows SENT or SENDING and resolves only by lookup (Y), never back to SENDING", () => {
    expect(canTransition(OUTBOUND, "SENT", "UNKNOWN", "Y")).toBe(true);
    for (const t of ["SENT", "DELIVERED", "UNDELIVERED", "FAILED"] as const) expect(canTransition(OUTBOUND, "UNKNOWN", t, "Y")).toBe(true);
    for (const t of ["SENDING", "QUEUED"] as const) for (const a of ACTORS) expect(canTransition(OUTBOUND, "UNKNOWN", t, a)).toBe(false);
  });
  it("therapist acknowledges or declines (AT-14); provider/guardian/agent cannot", () => {
    expect(canTransition(ACK, "PENDING", "ACKNOWLEDGED", "T")).toBe(true);
    expect(canTransition(ACK, "PENDING", "DECLINED", "T")).toBe(true);
    for (const a of ["P", "G", "A"] as const) expect(canTransition(ACK, "PENDING", "ACKNOWLEDGED", a)).toBe(false);
  });
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
  it("task close is system-only", () => {
    expect(canTransition(TASK, "RESOLVED_APPROVED", "CLOSED_VERIFIED", "S")).toBe(false);
    expect(canTransition(TASK, "RESOLVED_APPROVED", "CLOSED_VERIFIED", "Y")).toBe(true);
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
    expect(count(MACHINES.OUTBOUND as unknown as Machine<string>)).toBe(19);
    expect(count(MACHINES.RESERVATION as unknown as Machine<string>)).toBe(7);
    expect(count(MACHINES.CAPABILITY as unknown as Machine<string>)).toBe(11);
  });
});
