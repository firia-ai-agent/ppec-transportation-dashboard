"use client";
/**
 * Ramp iPad (SURF-04, PRD l.1061; design DESIGN-DIRECTION §4.4; copy COPY-GUIDE §5).
 *
 * Mock surface: client state and fixtures only. It reads nothing from the database, writes nothing
 * to an API, and sends no messages — the capability checklist feeds the deterministic capacity
 * solver (PRD §7) in the browser and the solver's verdict drives the banner. Approvals belong to a
 * coordinator (SURF-05), so this page proposes and records, and never assigns or approves.
 *
 * The vans at the ramp, the children on them and the time each run leaves the centre are the demo
 * scenario's own, through src/domain/plan/arrival.ts — the same day the Today board renders and
 * the same day Plan routes plans. They used to be a second fixture written beside this screen
 * (src/fixtures/fleet.ts), which named eight other children and could disagree with the plan
 * every other screen reads; there is one day under all three now.
 *
 * And the check no longer stops here. What the ramp finds is re-planned on screen by the solver's
 * own mover, and the result is a thing a coordinator can open: the two links under it carry the
 * finding to Plan routes and to the board, where the same re-plan is shown and decided about.
 *
 * Words come from src/ui/copy.ts and colours and metrics from the CSS custom properties
 * src/ui/tokens.ts emits in the root layout — this route holds neither its own copy nor its own
 * token table. The DEMO banner and the single NFR-09 source chip also come from the root layout,
 * so this page must not mount a second pair.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { feasible } from "@/domain/solver";
import type { AlternateCandidate, Child, LayoutPosition, SolveResult } from "@/domain/solver";
import { chairFitsPosition } from "@/domain/solver";
import {
  ARRIVAL_PARAM,
  encodeFinding,
  rampArrivals,
  replanForArrival,
} from "@/domain/plan/arrival";
import {
  MEASURED_AT_ARRIVAL,
  PLAN_SERVICE_DATE,
  reportedByProvider,
} from "@/domain/plan/day";
import { fill, layoutName, rampIpad, rampReplan, sentence, vanName } from "@/ui/copy";
import { holdLines, moveLines, stayLines } from "@/ui/arrival-lines";
import { StateChip } from "@/ui/StateChip";
import { serviceDateLabel } from "@/ui/service-date";
import { toneVars } from "@/ui/tokens";
import type { Tone } from "@/ui/tokens";
import {
  ANSWER_LABEL, POSITION_ANSWER_LABEL, availableSummary, bannerCopy, defaultChecklist,
  findingOfChecklist, isAmb, isWc, layoutOf, needChips, needSummary, positionDetail, positionName,
  toCapability,
} from "./capability";
import type { Answer, Checklist, PositionAnswer } from "./capability";
import { Icon } from "./icons";

type RiderActionKind = "BOARDED" | "NOT_ON_VEHICLE" | "LEFT_EARLY";
type RiderAction = { kind: RiderActionKind; pickedUpBy?: string; at: string; queueId: string; recordedLate: boolean };
type QueueEntry = { id: string; idempotencyKey: string; label: string; at: string; offline: boolean };
type Snack = { id: string; text: string; riderKey: string };

/**
 * The service date the fixtures describe, as "Tue, Oct 14" (COPY-GUIDE §3). Read at noon UTC so
 * the site timezone (America/New_York) lands on the same calendar day the fixture names.
 */
const SERVICE_DATE_LABEL = serviceDateLabel(new Date(`${PLAN_SERVICE_DATE}T12:00:00Z`));

/** §4.4: the checklist is 64 px toggle rows, and the vehicle tiles are big segmented tiles. */
const CHECKLIST_ROW_HEIGHT = 64;
const TILE_MIN_WIDTH = 260;
const TILE_MIN_HEIGHT = 84;

const CARD: React.CSSProperties = {
  background: "var(--color-surface)",
  border: "var(--border-hairline) solid var(--color-border-strong)",
  borderRadius: "var(--radius-md)",
  padding: "var(--space-5)",
};

const MUTED: React.CSSProperties = { color: "var(--color-ink-muted)", fontSize: "var(--text-16)" };

function Chip({ toneName, icon, children }: { toneName: Tone; icon: Parameters<typeof Icon>[0]["name"]; children: React.ReactNode }) {
  const vars = toneVars(toneName);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "var(--space-3)",
      padding: "var(--space-2) var(--space-4)", borderRadius: "var(--radius-pill)",
      background: vars.bg, color: vars.fg, fontSize: "var(--text-16)",
      fontWeight: "var(--weight-semibold)",
    }}>
      <Icon name={icon} />{children}
    </span>
  );
}

/**
 * The chosen answer is filled, not outlined (Vera's review).
 *
 * An outline in the brand tone is the same shape as the §9 focus ring, so on a shared iPad
 * "this is the answer we gave" and "this is where the keyboard is" read as one signal, and at
 * arm's length on a ramp neither reads at all. Filled is a different kind of answer: brand ink
 * under surface-white text — the §8 pair that passes AA at 6.70:1 — with a check mark beside
 * the label, so the state is never carried by colour alone (DESIGN-DIRECTION §3). `aria-pressed`
 * says the same thing to a screen reader.
 */
const SELECTED_PALETTE = {
  background: "var(--color-brand)",
  color: "var(--color-surface)",
  border: "var(--border-hairline) solid var(--color-brand)",
} as const;

function BigButton({
  label, onClick, variant = "secondary", disabled = false, pressed,
}: {
  label: string; onClick: () => void; variant?: "primary" | "secondary" | "quiet";
  disabled?: boolean; pressed?: boolean;
}) {
  const palette = variant === "primary" || pressed
    ? SELECTED_PALETTE
    : {
        background: "var(--color-surface)",
        color: "var(--color-ink)",
        border: "var(--border-hairline) solid var(--color-border-strong)",
      };
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} aria-pressed={pressed}
      style={{
        ...palette, minHeight: "var(--target-ramp)", padding: "0 var(--space-5)",
        borderRadius: "var(--radius-md)", fontSize: "var(--body-ramp)",
        fontWeight: "var(--weight-semibold)", cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1, fontFamily: "inherit",
        display: "inline-flex", alignItems: "center", gap: "var(--space-3)",
      }}
    >
      {pressed ? <Icon name="check" /> : null}
      {label}
    </button>
  );
}

/** A 64 px checklist row with Yes / No / Not sure (no hover-only anything). */
function AnswerRow<T extends string>({
  label, hint, value, options, labels, onChange,
}: {
  label: string; hint?: string; value: T; options: readonly T[];
  labels: Record<T, string>; onChange: (next: T) => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-5)",
      minHeight: CHECKLIST_ROW_HEIGHT,
      borderTop: "var(--border-hairline) solid var(--color-border-strong)",
      padding: "var(--space-3) 0", flexWrap: "wrap",
    }}>
      <span style={{ fontSize: "var(--body-ramp)" }}>
        {label}
        {hint ? <span style={{ display: "block", ...MUTED }}>{hint}</span> : null}
      </span>
      <span role="group" aria-label={label} style={{ display: "flex", gap: "var(--space-3)" }}>
        {options.map((option) => (
          <BigButton
            key={option} label={labels[option]} pressed={value === option}
            onClick={() => onChange(option)}
          />
        ))}
      </span>
    </div>
  );
}

export default function RampCheck() {
  const [arrivalIndex, setArrivalIndex] = useState(0);
  const [checklists, setChecklists] = useState<Record<string, Checklist>>({});
  /** Manual seat choices; null means "cleared the suggestion". Keyed "vehicleId:positionId". */
  const [seatChoices, setSeatChoices] = useState<Record<string, string | null>>({});
  const [openPosition, setOpenPosition] = useState<string | null>(null);
  const [riderActions, setRiderActions] = useState<Record<string, RiderAction>>({});
  const [armed, setArmed] = useState<string | null>(null);
  const [askingEarly, setAskingEarly] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [snack, setSnack] = useState<Snack | null>(null);
  /**
   * The chairs the ramp has measured itself, by child.
   *
   * Kept apart from the checklist on purpose: the §4.4 checklist is the *vehicle* check, and a
   * chair is not part of the vehicle. It is the one finding on this screen about a child, and
   * the one the plan has to be asked again about — see `rampIpad.measureChair`.
   */
  const [measuredChairs, setMeasuredChairs] = useState<readonly string[]>([]);

  /*
   * The feasibility banner is sticky, so while the page is scrolled it is pinned to the bottom
   * of the window and sits *over* whatever is behind it — which was the lift row, the second
   * walking seat and the top of the rider list. A sticky element reserves no space for itself,
   * so the page has to: `main` carries a bottom padding equal to the banner's height, measured
   * rather than guessed, because the banner grows a line every time the solver adds an option
   * and a hard-coded number would be wrong on the first run that doesn't fit.
   */
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const [bannerHeight, setBannerHeight] = useState(0);
  /** Collapsed to the verdict line by default; the reason and the options are one tap away. */
  const [bannerOpen, setBannerOpen] = useState(false);
  useEffect(() => {
    const node = bannerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setBannerHeight(node.offsetHeight));
    observer.observe(node);
    setBannerHeight(node.offsetHeight);
    return () => observer.disconnect();
  }, []);


  // The day's own afternoon runs. Deterministic and pure, so it is read once per mount.
  const arrivals = useMemo(() => rampArrivals(), []);
  const arrival = arrivals[arrivalIndex];
  const { vehicle, leg } = arrival;
  const checklist = checklists[vehicle.id] ?? defaultChecklist(vehicle, arrival.plannedLayoutId);
  const layout = layoutOf(vehicle, checklist.layoutId);

  const result: SolveResult = useMemo(() => {
    const capability = toCapability(vehicle, checklist, PLAN_SERVICE_DATE);
    const alternates: AlternateCandidate[] = arrivals
      .filter((other) => other.vehicle.id !== vehicle.id)
      .map((other) => ({
        vehicle: other.vehicle,
        leg: other.leg,
        // Checked on this iPad if ramp staff have filled it in, otherwise what the provider
        // reported for today. A van nobody has said anything about still takes nobody (VEH-04).
        capability: checklists[other.vehicle.id]
          ? toCapability(other.vehicle, checklists[other.vehicle.id], PLAN_SERVICE_DATE)
          : reportedByProvider(other.vehicle.id),
      }));
    return feasible(vehicle, leg, capability, { alternates });
  }, [arrivals, vehicle, leg, checklist, checklists]);

  /**
   * Is the vehicle check finished? Nothing is re-planned off a half-answered checklist.
   *
   * Not because an unanswered row is harmless — it is not, and the solver reads it as
   * unavailable exactly as it should (PRD §7 l.797) — but because a screen that opened on "three
   * children have no van" before anybody had touched a row would be shouting about the honest
   * starting state of every morning.
   */
  const checkFinished =
    checklist.lift !== "UNSURE" &&
    checklist.latch !== "UNSURE" &&
    layout.positions.every((p) => (checklist.positions[p.id] ?? "UNSURE") !== "UNSURE");

  /** This check as a fact about the van, which is what the other two screens read. */
  const finding = useMemo(
    () => findingOfChecklist(arrival, checklist, measuredChairs),
    [arrival, checklist, measuredChairs],
  );

  /**
   * The day re-planned around this van, by the solver's own mover.
   *
   * Computed whether or not the check is finished, because the panel below needs to know that
   * there is nothing to say as much as it needs to know what to say — but it is only *shown*
   * once the check is finished.
   */
  const replan = useMemo(() => replanForArrival(finding), [finding]);
  const findingCode = useMemo(() => encodeFinding(finding), [finding]);

  const need = useMemo(() => needSummary(leg), [leg]);
  const available = availableSummary(vehicle, checklist);
  const banner = bannerCopy(result, need, available);
  const bannerVars = toneVars(banner.tone);

  /** Seats the solver proposed for the busiest stop; ramp staff can change them. */
  const suggested = useMemo(() => {
    const busiest = [...result.plan].sort((a, b) => b.onboard.length - a.onboard.length)[0];
    return Object.fromEntries((busiest?.wcAssignments ?? []).map((a) => [a.positionId, a.childToken]));
  }, [result.plan]);

  const assignmentFor = (positionId: string): string | null => {
    const key = `${vehicle.id}:${positionId}`;
    return key in seatChoices ? seatChoices[key] : (suggested[positionId] ?? null);
  };
  const assignedTokens = new Set(
    layout.positions.map((p) => assignmentFor(p.id)).filter((t): t is string => t !== null),
  );

  useEffect(() => {
    if (!snack) return;
    const timer = setTimeout(() => setSnack(null), 3000);
    return () => clearTimeout(timer);
  }, [snack]);

  const setChecklist = (next: Checklist) => setChecklists((prev) => ({ ...prev, [vehicle.id]: next }));

  const chooseLayout = (layoutId: string) => {
    setChecklist({ ...defaultChecklist(vehicle, layoutId), lift: checklist.lift, latch: checklist.latch });
    setSeatChoices((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${vehicle.id}:`))));
    setOpenPosition(null);
  };

  const stamp = () => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  const record = useCallback((child: Child, kind: RiderActionKind, pickedUpBy?: string) => {
    const riderKey = `${vehicle.id}:${child.token}`;
    const queueId = crypto.randomUUID();
    const at = stamp();
    const action = kind === "BOARDED" ? rampIpad.boardingConfirmed
      : kind === "NOT_ON_VEHICLE" ? rampIpad.notOnVehicle
      : rampIpad.leftEarly;
    setQueue((prev) => [...prev, {
      id: queueId,
      // Saved once, even if this iPad retries later (PRD §12 mutations carry an idempotency key).
      idempotencyKey: crypto.randomUUID(),
      label: fill(rampIpad.queueLabel, { action, child: child.displayName }),
      at, offline,
    }]);
    setRiderActions((prev) => ({ ...prev, [riderKey]: { kind, pickedUpBy, at, queueId, recordedLate: false } }));
    setArmed(null);
    setAskingEarly(null);
    const template = kind === "BOARDED" ? rampIpad.snackBoarded
      : kind === "NOT_ON_VEHICLE" ? rampIpad.snackNotOnVehicle
      : rampIpad.snackLeftEarly;
    setSnack({ id: queueId, riderKey, text: sentence(fill(template, { child: child.displayName })) });
  }, [offline, vehicle.id]);

  const undo = (target: Snack) => {
    const action = riderActions[target.riderKey];
    if (action) setQueue((prev) => prev.filter((entry) => entry.id !== action.queueId));
    setRiderActions((prev) => {
      const next = { ...prev };
      delete next[target.riderKey];
      return next;
    });
    setSnack(null);
  };

  const goOnline = () => {
    setOffline(false);
    const late = new Set(queue.filter((entry) => entry.offline).map((entry) => entry.id));
    if (late.size === 0) return;
    setQueue((prev) => prev.map((entry) => (late.has(entry.id) ? { ...entry, offline: false } : entry)));
    setRiderActions((prev) => Object.fromEntries(Object.entries(prev).map(([key, action]) =>
      [key, late.has(action.queueId) ? { ...action, recordedLate: true } : action])));
  };

  /** Is there anything behind the verdict line worth a toggle? */
  const hasDetails = banner.detail !== null || result.options.length > 0;

  const savedOffline = queue.filter((entry) => entry.offline).length;
  const riders = [...leg.children];
  /** The chairs this run carries that the ramp can measure for itself. */
  const measurable = riders.filter((child) => MEASURED_AT_ARRIVAL[child.token] !== undefined);
  // Nobody boards until the check says the run fits: the solver blocks the manifest lock (PRD §9).
  const blockedReason = result.status === "FEASIBLE" ? null
    : result.status === "CAPABILITY_PENDING" ? rampIpad.blockedPending
    : rampIpad.blockedInfeasible;

  return (
    <main style={{
      background: "var(--color-bg)", color: "var(--color-ink)",
      // The DEMO bar (§7) is 32 px above this, so a full 100vh here would scroll the bar off
      // the top of every ramp screen for the sake of 32 px of nothing.
      minHeight: "calc(100vh - var(--layout-demo-banner-height))",
      fontSize: "var(--body-ramp)", padding: "var(--space-5)",
      // Room under the content for the sticky banner to be pinned over, instead of over a row.
      paddingBottom: `calc(var(--space-5) + ${bannerHeight}px)`,
    }}>
      {/* The DEMO bar and the one source chip ride in the root layout, on every route. */}
      <div style={{
        display: "flex", alignItems: "center", gap: "var(--space-4)", flexWrap: "wrap",
        marginBottom: "var(--space-5)",
      }}>
        <h1 style={{ fontSize: "var(--text-24)", margin: 0 }}>{rampIpad.heading}</h1>
        <span style={{ color: "var(--color-ink-muted)" }}>
          {fill(rampIpad.subtitle, { date: SERVICE_DATE_LABEL })}
        </span>
        {savedOffline > 0 ? (
          <span style={{ marginLeft: "auto" }}>
            <Chip toneName="warn" icon="offline">
              {fill(rampIpad.offlinePill, { count: savedOffline })}
            </Chip>
          </span>
        ) : null}
      </div>
      <p style={{ color: "var(--color-ink-muted)", marginTop: 0 }}>{rampIpad.localOnly}</p>

      {/* Arriving-vehicle selector */}
      <h2 style={{ fontSize: "var(--text-20)" }}>{rampIpad.arrivalsHeading}</h2>
      <div style={{
        display: "flex", gap: "var(--space-5)", flexWrap: "wrap", marginBottom: "var(--space-5)",
      }}>
        {arrivals.map((candidate, index) => {
          const chosen = index === arrivalIndex;
          return (
            <button
              key={candidate.vehicle.id} type="button" onClick={() => { setArrivalIndex(index); setOpenPosition(null); }}
              aria-pressed={chosen}
              style={{
                ...CARD, textAlign: "left", minWidth: TILE_MIN_WIDTH, minHeight: TILE_MIN_HEIGHT,
                cursor: "pointer", fontFamily: "inherit",
                fontSize: "var(--body-ramp)",
                // Filled when chosen, like every other selected control on this screen.
                color: chosen ? "var(--color-surface)" : "var(--color-ink)",
                background: chosen ? "var(--color-brand)" : "var(--color-surface)",
                borderColor: chosen ? "var(--color-brand)" : "var(--color-border-strong)",
              }}
            >
              <strong style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-3)" }}>
                {chosen ? <Icon name="check" /> : null}
                {fill(rampIpad.vehicleTile, {
                  vehicle: candidate.vehicle.label, provider: candidate.vehicle.providerName,
                })}
              </strong>
              <span style={{
                display: "block",
                // The muted ink token has no contrast to spend on brand violet-blue; on the
                // filled card the detail line rides the same surface-white as the title.
                color: chosen ? "var(--color-surface)" : "var(--color-ink-muted)",
              }}>
                {fill(rampIpad.vehicleTileDetail, {
                  description: candidate.vehicle.description,
                  time: candidate.leavesAt,
                  riders: candidate.riders.length,
                })}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: "var(--space-5)", alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Capability checklist */}
        <section style={{ ...CARD, flex: "1 1 420px" }} aria-labelledby="checklist-heading">
          <h2 id="checklist-heading" style={{ fontSize: "var(--text-20)", marginTop: 0 }}>
            {fill(rampIpad.checklistHeading, { vehicle: vanName(vehicle.description) })}
          </h2>
          <p style={{ color: "var(--color-ink-muted)", marginTop: 0 }}>{rampIpad.checklistIntro}</p>

          <fieldset style={{ border: 0, padding: 0, margin: "0 0 var(--space-5)" }}>
            <legend style={{ fontWeight: "var(--weight-semibold)", padding: 0 }}>
              {rampIpad.layoutLegend}
            </legend>
            <div style={{
              display: "flex", gap: "var(--space-3)", flexWrap: "wrap", marginTop: "var(--space-3)",
            }}>
              {vehicle.layouts.map((candidate) => (
                <BigButton
                  // "1 wheelchair · 3 seats", not the provider's "1WC/3A" shorthand.
                  key={candidate.id} label={layoutName(candidate.code)}
                  pressed={candidate.id === layout.id}
                  onClick={() => chooseLayout(candidate.id)}
                />
              ))}
            </div>
          </fieldset>

          <AnswerRow
            label={rampIpad.liftRow} value={checklist.lift} options={["YES", "NO", "UNSURE"] as const}
            labels={ANSWER_LABEL} onChange={(lift: Answer) => setChecklist({ ...checklist, lift })}
          />
          {layout.positions.map((position, index) => {
            const ordinal = layout.positions.filter((p, i) => i < index && p.kind === position.kind).length + 1;
            return (
              <AnswerRow
                key={position.id}
                label={positionName(position, ordinal)}
                hint={positionDetail(position) || undefined}
                value={checklist.positions[position.id] ?? "UNSURE"}
                options={["FREE", "OUT", "UNSURE"] as const} labels={POSITION_ANSWER_LABEL}
                onChange={(answer: PositionAnswer) => setChecklist({
                  ...checklist, positions: { ...checklist.positions, [position.id]: answer },
                })}
              />
            );
          })}
          <AnswerRow
            label={rampIpad.latchRow} value={checklist.latch} options={["YES", "NO", "UNSURE"] as const}
            labels={ANSWER_LABEL} onChange={(latch: Answer) => setChecklist({ ...checklist, latch })}
          />

          <div style={{
            display: "flex", gap: "var(--space-3)", flexWrap: "wrap", marginTop: "var(--space-5)",
          }}>
            <Chip toneName="neutral" icon="wheelchair">
              {fill(rampIpad.wcFree, { available: available.wc, needed: need.wc })}
            </Chip>
            <Chip toneName="neutral" icon="seat">
              {fill(rampIpad.ambFree, { available: available.amb, needed: need.amb })}
            </Chip>
            <Chip toneName="neutral" icon="seat">
              {fill(rampIpad.tetherFree, { available: available.tether, needed: need.tether })}
            </Chip>
          </div>
          <p style={{ marginBottom: 0 }}>
            <BigButton
              label={offline ? rampIpad.wifiBack : rampIpad.loseWifi}
              onClick={() => (offline ? goOnline() : setOffline(true))}
            />
          </p>
        </section>

        {/* Slot allocation matrix + riders */}
        <section style={{
          flex: "1 1 460px", display: "flex", flexDirection: "column", gap: "var(--space-5)",
        }}>
          <div style={CARD} aria-labelledby="slots-heading">
            <h2 id="slots-heading" style={{ fontSize: "var(--text-20)", marginTop: 0 }}>
              {rampIpad.slotsHeading}
            </h2>
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
              gap: "var(--space-3)",
            }}>
              {layout.positions.map((position, index) => {
                const ordinal = layout.positions.filter((p, i) => i < index && p.kind === position.kind).length + 1;
                const answer = checklist.positions[position.id] ?? "UNSURE";
                const occupant = riders.find((child) => child.token === assignmentFor(position.id));
                const open = openPosition === position.id;
                const eligible = riders.filter((child) => eligibleFor(child, position) && !assignedTokens.has(child.token));
                return (
                  <div key={position.id} style={{
                    border: "var(--border-hairline) solid var(--color-border-strong)",
                    borderRadius: "var(--radius-md)", padding: "var(--space-4)",
                    background: answer === "FREE" ? "var(--color-surface)" : "var(--color-neutral-bg)",
                  }}>
                    <span style={{ fontWeight: "var(--weight-semibold)", display: "block" }}>
                      {positionName(position, ordinal)}
                    </span>
                    <span style={{ ...MUTED, display: "block" }}>{positionDetail(position)}</span>
                    <span style={{ display: "block", margin: "var(--space-3) 0" }}>
                      {answer !== "FREE"
                        ? <Chip toneName={answer === "OUT" ? "crit" : "warn"} icon={answer === "OUT" ? "ban" : "question"}>
                            {POSITION_ANSWER_LABEL[answer]}
                          </Chip>
                        : occupant
                          ? <Chip toneName="info" icon="check">{occupant.displayName}</Chip>
                          : <Chip toneName="neutral" icon="seat">{rampIpad.free}</Chip>}
                    </span>
                    {answer === "FREE" ? (
                      <BigButton
                        label={open ? rampIpad.close : occupant ? rampIpad.change : rampIpad.assign}
                        onClick={() => setOpenPosition(open ? null : position.id)} pressed={open}
                      />
                    ) : null}
                    {open ? (
                      <div style={{
                        display: "flex", flexDirection: "column", gap: "var(--space-3)",
                        marginTop: "var(--space-3)",
                      }}>
                        {occupant ? (
                          <BigButton label={rampIpad.clearSeat} onClick={() => {
                            setSeatChoices((prev) => ({ ...prev, [`${vehicle.id}:${position.id}`]: null }));
                            setOpenPosition(null);
                          }} />
                        ) : null}
                        {eligible.map((child) => (
                          <BigButton key={child.token} label={child.displayName} onClick={() => {
                            setSeatChoices((prev) => ({ ...prev, [`${vehicle.id}:${position.id}`]: child.token }));
                            setOpenPosition(null);
                          }} />
                        ))}
                        {eligible.length === 0 && !occupant ? (
                          <span style={MUTED}>{rampIpad.noEligibleRider}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={CARD}>
            <h2 style={{ fontSize: "var(--text-20)", marginTop: 0 }}>{rampIpad.ridersHeading}</h2>
            {riders.map((child) => {
              const riderKey = `${vehicle.id}:${child.token}`;
              const action = riderActions[riderKey];
              const isArmed = armed === riderKey;
              return (
                <div key={child.token} style={{
                  borderTop: "var(--border-hairline) solid var(--color-border-strong)",
                  padding: "var(--space-5) 0",
                }}>
                  <div style={{
                    display: "flex", gap: "var(--space-3)", alignItems: "baseline", flexWrap: "wrap",
                  }}>
                    <strong style={{ fontSize: "var(--text-20)" }}>{child.displayName}</strong>
                    {child.boarded ? <Chip toneName="info" icon="check">{rampIpad.boardedReported}</Chip> : null}
                    {action?.kind === "BOARDED" ? (
                      <Chip toneName="ok" icon="check">{fill(rampIpad.boardedVerified, { time: action.at })}</Chip>
                    ) : null}
                    {action?.kind === "NOT_ON_VEHICLE" ? (
                      <Chip toneName="neutral" icon="ban">{fill(rampIpad.notOnVehicleChip, { time: action.at })}</Chip>
                    ) : null}
                    {action?.kind === "LEFT_EARLY" ? (
                      <Chip toneName="warn" icon="alert">
                        {fill(rampIpad.leftEarlyChip, { by: action.pickedUpBy ?? "", time: action.at })}
                      </Chip>
                    ) : null}
                    {action?.recordedLate ? (
                      <Chip toneName="neutral" icon="offline">{rampIpad.recordedLate}</Chip>
                    ) : null}
                  </div>
                  <div style={{
                    display: "flex", gap: "var(--space-3)", flexWrap: "wrap", margin: "var(--space-3) 0",
                  }}>
                    {needChips(child).map((chip) => (
                      <span key={chip} style={{
                        border: "var(--border-hairline) solid var(--color-border-strong)",
                        borderRadius: "var(--radius-pill)", padding: "var(--space-2) var(--space-4)",
                        ...MUTED,
                      }}>{chip}</span>
                    ))}
                  </div>
                  <p style={{ ...MUTED, margin: "0 0 var(--space-3)" }}>{rampIpad.needsCaption}</p>
                  {/*
                    The chair, measured here rather than taken from the file. Offered only for a
                    child whose chair the day has a measurement for, and the line under it
                    compares the two numbers instead of asserting that they differ.
                  */}
                  {measurable.includes(child) ? (
                    <div style={{ margin: "0 0 var(--space-3)" }}>
                      {measuredChairs.includes(child.token) ? (
                        <>
                          <Chip toneName="info" icon="check">
                            {fill(rampIpad.measuredChip, {
                              length: MEASURED_AT_ARRIVAL[child.token].wcLengthCm,
                              width: MEASURED_AT_ARRIVAL[child.token].wcWidthCm,
                            })}
                          </Chip>
                          <p style={{ ...MUTED, margin: "var(--space-3) 0 0" }}>
                            {chairDiffers(child)
                              ? fill(rampIpad.measuredDiffers, {
                                  length: child.wcLengthCm ?? 0,
                                  width: child.wcWidthCm ?? 0,
                                })
                              : rampIpad.measuredMatches}
                          </p>
                        </>
                      ) : (
                        <BigButton
                          label={rampIpad.measureChair}
                          onClick={() =>
                            setMeasuredChairs((prev) => [...prev, child.token])
                          }
                        />
                      )}
                    </div>
                  ) : null}
                  {action ? null : (
                    <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
                      <BigButton
                        variant="primary" disabled={blockedReason !== null}
                        label={isArmed ? rampIpad.confirmAgain : rampIpad.confirmBoarding}
                        onClick={() => (isArmed ? record(child, "BOARDED") : setArmed(riderKey))}
                      />
                      <BigButton label={rampIpad.notOnVehicle} onClick={() => record(child, "NOT_ON_VEHICLE")} />
                      <BigButton
                        label={rampIpad.leftEarly} pressed={askingEarly === riderKey}
                        onClick={() => setAskingEarly(askingEarly === riderKey ? null : riderKey)}
                      />
                    </div>
                  )}
                  {blockedReason !== null && !action ? (
                    <p style={{
                      color: result.status === "CAPABILITY_PENDING"
                        ? "var(--color-warn-fg)" : "var(--color-crit-fg)",
                      margin: "var(--space-3) 0 0",
                    }}>
                      {blockedReason}
                    </p>
                  ) : null}
                  {askingEarly === riderKey ? (
                    <div
                      role="group"
                      aria-label={fill(rampIpad.whoPickedUpFor, { child: child.displayName })}
                      style={{ marginTop: "var(--space-3)" }}
                    >
                      <p style={{ margin: "0 0 var(--space-3)" }}>{rampIpad.whoPickedUp}</p>
                      <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
                        {rampIpad.pickupRoles.map((role) => (
                          <BigButton key={role} label={role} onClick={() => record(child, "LEFT_EARLY", role)} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/*
            What this check does to the afternoon: the solver's answer, on the screen that took
            the check, and a link that hands the same answer to the two screens that decide
            about it. Nothing in here is a decision — every line is a proposal, and the last
            one says so.
          */}
          <div style={CARD} id="ramp-replan" aria-labelledby="replan-heading">
            <h2 id="replan-heading" style={{ fontSize: "var(--text-20)", marginTop: 0 }}>
              {rampReplan.heading}
            </h2>
            {!checkFinished ? (
              <p style={{ ...MUTED, margin: 0 }}>{rampIpad.notCheckedDetail}</p>
            ) : !replan.changed ? (
              <>
                <p style={{ margin: 0 }}>{rampReplan.nothingChanged}</p>
                <p style={{ ...MUTED, margin: "var(--space-3) 0 0" }}>
                  {rampReplan.nothingChangedDetail}
                </p>
              </>
            ) : (
              <>
                <p style={{ margin: 0 }}>{rampReplan.changedDetail}</p>
                <OutcomeGroup heading={rampReplan.heldHeading} lines={holdLines(replan)} />
                <OutcomeGroup heading={rampReplan.movedHeading} lines={moveLines(replan)} />
                <OutcomeGroup heading={rampReplan.staysHeading} lines={stayLines(replan)} />
                <p style={{ ...MUTED, margin: "var(--space-5) 0 0" }}>{rampReplan.decides}</p>
              </>
            )}
            {checkFinished ? (
              <p style={{
                display: "flex", gap: "var(--space-3)", flexWrap: "wrap",
                margin: "var(--space-5) 0 0",
              }}>
                <OnwardLink
                  href={`/plan-routes?${ARRIVAL_PARAM}=${encodeURIComponent(findingCode)}`}
                  label={rampReplan.openPlan}
                />
                <OnwardLink
                  href={`/today?${ARRIVAL_PARAM}=${encodeURIComponent(findingCode)}`}
                  label={rampReplan.openBoard}
                />
              </p>
            ) : null}
          </div>

          {queue.length > 0 ? (
            <div style={CARD}>
              <h2 style={{ fontSize: "var(--text-20)", marginTop: 0 }}>{rampIpad.queueHeading}</h2>
              <ul style={{ margin: 0, paddingLeft: "var(--space-6)" }}>
                {queue.map((entry) => (
                  <li key={entry.id} style={{ marginBottom: "var(--space-3)" }}>
                    {fill(rampIpad.queueRow, { label: entry.label, time: entry.at })}{" "}
                    {entry.offline
                      ? <Chip toneName="warn" icon="offline">{rampIpad.queueWaiting}</Chip>
                      : <Chip toneName="neutral" icon="check">{rampIpad.queueSaved}</Chip>}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>

      {/* Sticky feasibility banner, driven by the solver. The id is how the browser check
          finds it to prove it covers no row; nothing else depends on it. */}
      <div id="ramp-verdict" ref={bannerRef} style={{
        position: "sticky", bottom: 0, marginTop: "var(--space-5)", background: bannerVars.bg,
        color: bannerVars.fg, border: `var(--border-hairline) solid ${bannerVars.fg}`,
        borderRadius: "var(--radius-md)", padding: "var(--space-5)",
      }}>
        <div style={{
          display: "flex", gap: "var(--space-4)", alignItems: "center", flexWrap: "wrap",
          fontSize: "var(--text-20)", fontWeight: "var(--weight-semibold)",
        }}>
          <Icon name={banner.tone === "ok" ? "check" : banner.tone === "warn" ? "question" : "alert"} />
          {banner.title}
          {hasDetails ? (
            <span style={{ marginLeft: "auto" }}>
              <BigButton
                label={bannerOpen ? rampIpad.hideDetails : rampIpad.showDetails}
                onClick={() => setBannerOpen((open) => !open)}
              />
            </span>
          ) : null}
        </div>
        {bannerOpen && banner.detail ? (
          <p style={{ margin: "var(--space-3) 0 0" }}>{banner.detail}</p>
        ) : null}
        {bannerOpen && result.options.length > 0 ? (
          <div style={{ marginTop: "var(--space-5)", color: "var(--color-ink)" }}>
            <h3 style={{ fontSize: "var(--body-ramp)", margin: "0 0 var(--space-3)" }}>
              {rampIpad.optionsHeading}
            </h3>
            <ol style={{ margin: 0, paddingLeft: "var(--space-6)" }}>
              {result.options.map((option) => (
                <li key={option.id} style={{ marginBottom: "var(--space-3)" }}>
                  {fill(rampIpad.optionRow, { label: option.label, detail: option.detail })}{" "}
                  <Chip toneName="neutral" icon="question">{rampIpad.needsApproval}</Chip>
                </li>
              ))}
            </ol>
            <p style={{ color: "var(--color-ink-muted)", marginBottom: 0 }}>{rampIpad.optionsNote}</p>
          </div>
        ) : null}
      </div>

      <div aria-live="polite" style={{
        position: "fixed", bottom: "calc(var(--space-8) * 2)", left: "var(--space-5)",
      }}>
        {snack ? (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: "var(--space-4)",
            background: "var(--color-ink)", color: "var(--color-surface)",
            padding: "var(--space-4) var(--space-5)", borderRadius: "var(--radius-md)",
          }}>
            {snack.text}
            <button
              type="button" onClick={() => undo(snack)}
              style={{
                background: "transparent", color: "var(--color-surface)",
                border: "var(--border-hairline) solid var(--color-surface)",
                borderRadius: "var(--radius-md)", minHeight: "var(--target-console)",
                padding: "0 var(--space-5)", fontSize: "var(--text-16)",
                fontWeight: "var(--weight-semibold)", cursor: "pointer", fontFamily: "inherit",
                outline: "var(--focus-width) solid var(--color-focus)",
                outlineOffset: "var(--focus-offset)",
              }}
            >
              {rampIpad.undo}
            </button>
          </span>
        ) : null}
      </div>
    </main>
  );
}

/**
 * One group of the re-plan: the children it is about, each on their own line, with the state
 * chip where the day has one to show. Empty groups render nothing rather than a heading over
 * nothing.
 */
function OutcomeGroup({
  heading, lines,
}: { heading: string; lines: ReturnType<typeof moveLines> }) {
  if (lines.length === 0) return null;
  return (
    <div style={{ marginTop: "var(--space-5)" }}>
      <h3 style={{ fontSize: "var(--body-ramp)", margin: "0 0 var(--space-3)" }}>{heading}</h3>
      <ul style={{ margin: 0, paddingLeft: "var(--space-6)" }}>
        {lines.map((line) => (
          <li key={line.childToken} style={{ marginBottom: "var(--space-3)" }}>
            {line.text}{" "}
            {line.state ? <StateChip state={line.state} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A link that hands this ramp check to another screen.
 *
 * A link and not a button: it goes somewhere, so it is the element that goes somewhere — which
 * is also what lets a middle click open the plan beside the ramp, which is how somebody
 * standing at a van with a coordinator on the phone would want to use it. Sized to the ramp's
 * own target so it is tappable with a glove on.
 */
function OnwardLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      style={{
        display: "inline-flex", alignItems: "center", gap: "var(--space-3)",
        minHeight: "var(--target-ramp)", padding: "0 var(--space-5)",
        borderRadius: "var(--radius-md)",
        border: "var(--border-hairline) solid var(--color-border-strong)",
        background: "var(--color-surface)", color: "var(--color-ink)",
        fontSize: "var(--body-ramp)", fontWeight: "var(--weight-semibold)",
        textDecoration: "none",
      }}
    >
      <Icon name="check" />
      {label}
    </a>
  );
}

/**
 * Did the chair the ramp measured come out different from the approved profile?
 *
 * Asked rather than assumed: the screen says "bigger than the 128 × 70 cm on file" only when the
 * two numbers actually differ, so the line stays true if a measurement is ever added that agrees
 * with the file.
 */
function chairDiffers(child: Child): boolean {
  const measured = MEASURED_AT_ARRIVAL[child.token];
  if (!measured) return false;
  return measured.wcLengthCm !== child.wcLengthCm || measured.wcWidthCm !== child.wcWidthCm;
}

/** A rider can only be placed where the four constraints allow (PRD §7). */
function eligibleFor(child: Child, position: LayoutPosition): boolean {
  if (isWc(position)) return child.mobility === "WC" && chairFitsPosition(child, position);
  if (child.mobility !== "AMB") return false;
  return isAmb(position) && (!child.tether || position.tetherCapable);
}
