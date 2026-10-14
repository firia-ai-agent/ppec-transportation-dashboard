"use client";
/**
 * Ramp iPad preview (SURF-04, PRD l.1061; design DESIGN-DIRECTION §4.4; copy COPY-GUIDE §5).
 *
 * Mock surface: client state and fixtures only. It reads nothing from the database, writes nothing
 * to an API, and sends no messages — the capability checklist feeds the deterministic capacity
 * solver (PRD §7) in the browser and the solver's verdict drives the banner. Approvals belong to a
 * coordinator (SURF-05), so this page proposes and records, and never assigns or approves.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { feasible } from "@/domain/solver";
import type { AlternateCandidate, Child, LayoutPosition, SolveResult } from "@/domain/solver";
import { chairFitsPosition } from "@/domain/solver";
import { ARRIVING_VEHICLES, SERVICE_DATE, fullyAvailable } from "@/fixtures/fleet";
import {
  ANSWER_LABEL, POSITION_ANSWER_LABEL, availableSummary, bannerCopy, defaultChecklist, isAmb, isWc,
  layoutOf, needChips, needSummary, positionLabel, toCapability,
} from "./capability";
import type { Answer, Checklist, PositionAnswer } from "./capability";
import { Icon } from "./icons";
import { color, focusRing, size, tone } from "./tokens";
import type { Tone } from "./tokens";

type RiderActionKind = "BOARDED" | "NOT_ON_VEHICLE" | "LEFT_EARLY";
type RiderAction = { kind: RiderActionKind; pickedUpBy?: string; at: string; queueId: string; recordedLate: boolean };
type QueueEntry = { id: string; idempotencyKey: string; label: string; at: string; offline: boolean };
type Snack = { id: string; text: string; riderKey: string };

/** Who collected a child who left early. Roles only: no free-text names in the demo. */
const PICKUP_ROLES = ["Parent or guardian", "Approved adult on the pickup list", "PPEC staff"];

const CARD: React.CSSProperties = {
  background: color.surface, border: `1px solid ${color.border}`, borderRadius: size.radius, padding: size.gap,
};

function Chip({ toneName, icon, children }: { toneName: Tone; icon: Parameters<typeof Icon>[0]["name"]; children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999,
      background: tone[toneName].bg, color: tone[toneName].fg, fontSize: 15, fontWeight: 600,
    }}>
      <Icon name={icon} size={18} />{children}
    </span>
  );
}

function BigButton({
  label, onClick, variant = "secondary", disabled = false, pressed,
}: {
  label: string; onClick: () => void; variant?: "primary" | "secondary" | "quiet";
  disabled?: boolean; pressed?: boolean;
}) {
  const palette = variant === "primary"
    ? { background: color.brand, color: color.surface, border: `1px solid ${color.brand}` }
    : { background: color.surface, color: color.ink, border: `1px solid ${pressed ? color.brand : color.borderStrong}` };
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} aria-pressed={pressed}
      style={{
        ...palette, minHeight: size.target, padding: "0 18px", borderRadius: size.radius,
        fontSize: size.body, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1, fontFamily: "inherit",
      }}
    >
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
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: size.gap,
      minHeight: 64, borderTop: `1px solid ${color.border}`, padding: "8px 0", flexWrap: "wrap",
    }}>
      <span style={{ fontSize: size.body }}>
        {label}
        {hint ? <span style={{ display: "block", color: color.inkMuted, fontSize: 15 }}>{hint}</span> : null}
      </span>
      <span role="group" aria-label={label} style={{ display: "flex", gap: 8 }}>
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

export default function RampPreviewPage() {
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

  const arrival = ARRIVING_VEHICLES[arrivalIndex];
  const { vehicle, leg } = arrival;
  const checklist = checklists[vehicle.id] ?? defaultChecklist(vehicle, arrival.plannedLayoutId);
  const layout = layoutOf(vehicle, checklist.layoutId);

  const result: SolveResult = useMemo(() => {
    const capability = toCapability(vehicle, checklist, SERVICE_DATE);
    const alternates: AlternateCandidate[] = ARRIVING_VEHICLES
      .filter((other) => other.vehicle.id !== vehicle.id)
      .map((other) => ({
        vehicle: other.vehicle,
        leg: other.leg,
        // Checked on this iPad if ramp staff have filled it in, otherwise what the provider reported.
        capability: checklists[other.vehicle.id]
          ? toCapability(other.vehicle, checklists[other.vehicle.id], SERVICE_DATE)
          : fullyAvailable(other.vehicle, { state: "REPORTED", observedLayoutId: other.plannedLayoutId }),
      }));
    return feasible(vehicle, leg, capability, { alternates });
  }, [vehicle, leg, checklist, checklists]);

  const need = useMemo(() => needSummary(leg), [leg]);
  const available = availableSummary(vehicle, checklist);
  const banner = bannerCopy(result, need, available);

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
    setQueue((prev) => [...prev, {
      id: queueId,
      // Saved once, even if this iPad retries later (PRD §12 mutations carry an idempotency key).
      idempotencyKey: crypto.randomUUID(),
      label: `${kind === "BOARDED" ? "Boarding confirmed" : kind === "NOT_ON_VEHICLE" ? "Not on vehicle" : "Left early"} · ${child.displayName}`,
      at, offline,
    }]);
    setRiderActions((prev) => ({ ...prev, [riderKey]: { kind, pickedUpBy, at, queueId, recordedLate: false } }));
    setArmed(null);
    setAskingEarly(null);
    setSnack({
      id: queueId, riderKey,
      text: kind === "BOARDED" ? `Boarding confirmed for ${child.displayName}.`
        : kind === "NOT_ON_VEHICLE" ? `${child.displayName} marked not on vehicle.`
        : `${child.displayName} marked left early.`,
    });
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

  const savedOffline = queue.filter((entry) => entry.offline).length;
  const riders = [...leg.children];
  // Nobody boards until the check says the run fits: the solver blocks the manifest lock (PRD §9).
  const blockedReason = result.status === "FEASIBLE" ? null
    : result.status === "CAPABILITY_PENDING" ? "Finish the vehicle check first. Every row needs Yes or No."
    : "The run doesn’t fit yet. A coordinator decides before anyone boards.";

  return (
    <main style={{ background: color.bg, color: color.ink, minHeight: "100vh", fontSize: size.body, padding: size.gap }}>
      {/* DEMO banner + source chip: every screen says where its data comes from (NFR-09). */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: size.gap }}>
        <span role="status" aria-label="DEMO" style={{
          background: color.demoBg, color: color.demoFg, padding: "8px 16px", borderRadius: size.radius,
          fontWeight: 700, letterSpacing: 1,
        }}>DEMO</span>
        <span style={{
          border: `1px solid ${color.srcSim}`, color: color.srcSim, padding: "6px 12px", borderRadius: 999, fontWeight: 600,
        }}>Simulated</span>
        <h1 style={{ fontSize: 24, margin: 0 }}>Ramp check</h1>
        <span style={{ color: color.inkMuted }}>Tue, Oct 14 · afternoon rides</span>
        {savedOffline > 0 ? (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 8, marginLeft: "auto",
            background: tone.warn.bg, color: tone.warn.fg, padding: "8px 14px", borderRadius: 999, fontWeight: 600,
          }}>
            <Icon name="offline" />{`Offline · ${savedOffline} saved on this iPad. They'll send when Wi-Fi is back.`}
          </span>
        ) : null}
      </div>
      <p style={{ color: color.inkMuted, marginTop: 0 }}>
        Nothing on this page is sent anywhere. Answers stay in this browser so the vehicle check can be walked through.
      </p>

      {/* Arriving-vehicle selector */}
      <h2 style={{ fontSize: 20 }}>Which vehicle is at the ramp?</h2>
      <div style={{ display: "flex", gap: size.gap, flexWrap: "wrap", marginBottom: size.gap }}>
        {ARRIVING_VEHICLES.map((candidate, index) => (
          <button
            key={candidate.vehicle.id} type="button" onClick={() => { setArrivalIndex(index); setOpenPosition(null); }}
            aria-pressed={index === arrivalIndex}
            style={{
              ...CARD, textAlign: "left", minWidth: 260, minHeight: 84, cursor: "pointer", fontFamily: "inherit",
              fontSize: size.body, color: color.ink,
              borderColor: index === arrivalIndex ? color.brand : color.border,
              borderWidth: index === arrivalIndex ? 2 : 1,
            }}
          >
            <strong>{candidate.vehicle.label}</strong> · {candidate.vehicle.providerName}
            <span style={{ display: "block", color: color.inkMuted }}>
              {`arriving ${candidate.arrivingAt} · ${candidate.leg.children.length} riders`}
            </span>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: size.gap, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Capability checklist */}
        <section style={{ ...CARD, flex: "1 1 420px" }} aria-labelledby="checklist-heading">
          <h2 id="checklist-heading" style={{ fontSize: 20, marginTop: 0 }}>
            {`What can ${vehicle.label} carry today?`}
          </h2>
          <p style={{ color: color.inkMuted, marginTop: 0 }}>
            Unknown until arrival is normal. Anything left on “Not sure” keeps the run unchecked.
          </p>

          <fieldset style={{ border: 0, padding: 0, margin: `0 0 ${size.gap}px` }}>
            <legend style={{ fontWeight: 600, padding: 0 }}>How is the vehicle set up?</legend>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {vehicle.layouts.map((candidate) => (
                <BigButton
                  key={candidate.id} label={candidate.code} pressed={candidate.id === layout.id}
                  onClick={() => chooseLayout(candidate.id)}
                />
              ))}
            </div>
          </fieldset>

          <AnswerRow
            label="Lift works?" value={checklist.lift} options={["YES", "NO", "UNSURE"] as const}
            labels={ANSWER_LABEL} onChange={(lift: Answer) => setChecklist({ ...checklist, lift })}
          />
          {layout.positions.map((position, index) => {
            const ordinal = layout.positions.filter((p, i) => i < index && p.kind === position.kind).length + 1;
            return (
              <AnswerRow
                key={position.id}
                label={isWc(position) ? `Wheelchair position ${ordinal}` : `Walking seat ${ordinal}`}
                hint={positionLabel(position, ordinal).split(" · ").slice(1).join(" · ") || undefined}
                value={checklist.positions[position.id] ?? "UNSURE"}
                options={["FREE", "OUT", "UNSURE"] as const} labels={POSITION_ANSWER_LABEL}
                onChange={(answer: PositionAnswer) => setChecklist({
                  ...checklist, positions: { ...checklist.positions, [position.id]: answer },
                })}
              />
            );
          })}
          <AnswerRow
            label="Car-seat anchors (LATCH)" value={checklist.latch} options={["YES", "NO", "UNSURE"] as const}
            labels={ANSWER_LABEL} onChange={(latch: Answer) => setChecklist({ ...checklist, latch })}
          />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: size.gap }}>
            <Chip toneName="neutral" icon="wheelchair">{`Wheelchair places free: ${available.wc} of ${need.wc} needed`}</Chip>
            <Chip toneName="neutral" icon="seat">{`Walking seats free: ${available.amb} of ${need.amb} needed`}</Chip>
            <Chip toneName="neutral" icon="seat">{`Anchored seats free: ${available.tether} of ${need.tether} needed`}</Chip>
          </div>
          <p style={{ marginBottom: 0 }}>
            <BigButton
              label={offline ? "Wi-Fi is back" : "Simulate losing Wi-Fi"}
              onClick={() => (offline ? goOnline() : setOffline(true))}
            />
          </p>
        </section>

        {/* Slot allocation matrix + riders */}
        <section style={{ flex: "1 1 460px", display: "flex", flexDirection: "column", gap: size.gap }}>
          <div style={CARD} aria-labelledby="slots-heading">
            <h2 id="slots-heading" style={{ fontSize: 20, marginTop: 0 }}>Who sits where</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 }}>
              {layout.positions.map((position, index) => {
                const ordinal = layout.positions.filter((p, i) => i < index && p.kind === position.kind).length + 1;
                const answer = checklist.positions[position.id] ?? "UNSURE";
                const occupant = riders.find((child) => child.token === assignmentFor(position.id));
                const open = openPosition === position.id;
                const eligible = riders.filter((child) => eligibleFor(child, position) && !assignedTokens.has(child.token));
                return (
                  <div key={position.id} style={{
                    border: `1px solid ${answer === "FREE" ? color.border : color.borderStrong}`,
                    borderRadius: size.radius, padding: 10,
                    background: answer === "FREE" ? color.surface : color.neutralBg,
                  }}>
                    <span style={{ fontWeight: 600, display: "block" }}>
                      {isWc(position) ? `Wheelchair position ${ordinal}` : `Walking seat ${ordinal}`}
                    </span>
                    <span style={{ color: color.inkMuted, fontSize: 15, display: "block" }}>
                      {positionLabel(position, ordinal).split(" · ").slice(1).join(" · ")}
                    </span>
                    <span style={{ display: "block", margin: "6px 0" }}>
                      {answer !== "FREE"
                        ? <Chip toneName={answer === "OUT" ? "crit" : "warn"} icon={answer === "OUT" ? "ban" : "question"}>
                            {POSITION_ANSWER_LABEL[answer]}
                          </Chip>
                        : occupant
                          ? <Chip toneName="info" icon="check">{occupant.displayName}</Chip>
                          : <Chip toneName="neutral" icon="seat">Free</Chip>}
                    </span>
                    {answer === "FREE" ? (
                      <BigButton
                        label={open ? "Close" : occupant ? "Change" : "Assign"}
                        onClick={() => setOpenPosition(open ? null : position.id)} pressed={open}
                      />
                    ) : null}
                    {open ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                        {occupant ? (
                          <BigButton label="Clear seat" onClick={() => {
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
                          <span style={{ color: color.inkMuted, fontSize: 15 }}>
                            No rider on this run fits this place.
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={CARD}>
            <h2 style={{ fontSize: 20, marginTop: 0 }}>Riders</h2>
            {riders.map((child) => {
              const riderKey = `${vehicle.id}:${child.token}`;
              const action = riderActions[riderKey];
              const isArmed = armed === riderKey;
              return (
                <div key={child.token} style={{ borderTop: `1px solid ${color.border}`, padding: `${size.gap}px 0` }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 20 }}>{child.displayName}</strong>
                    {child.boarded ? <Chip toneName="info" icon="check">Boarded (reported)</Chip> : null}
                    {action?.kind === "BOARDED" ? <Chip toneName="ok" icon="check">{`Boarded, verified · ${action.at}`}</Chip> : null}
                    {action?.kind === "NOT_ON_VEHICLE" ? <Chip toneName="neutral" icon="ban">{`Not on vehicle · ${action.at}`}</Chip> : null}
                    {action?.kind === "LEFT_EARLY" ? <Chip toneName="warn" icon="alert">{`Left early · ${action.pickedUpBy} · ${action.at}`}</Chip> : null}
                    {action?.recordedLate ? <Chip toneName="neutral" icon="offline">Recorded late</Chip> : null}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "6px 0" }}>
                    {needChips(child).map((chip) => (
                      <span key={chip} style={{
                        border: `1px solid ${color.border}`, borderRadius: 999, padding: "4px 10px",
                        fontSize: 15, color: color.inkMuted,
                      }}>{chip}</span>
                    ))}
                  </div>
                  <p style={{ color: color.inkMuted, fontSize: 15, margin: "0 0 8px" }}>
                    Derived from intake, not a diagnosis.
                  </p>
                  {action ? null : (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <BigButton
                        variant="primary" disabled={blockedReason !== null}
                        label={isArmed ? "Tap again to confirm" : "Confirm boarding & securement"}
                        onClick={() => (isArmed ? record(child, "BOARDED") : setArmed(riderKey))}
                      />
                      <BigButton label="Not on vehicle" onClick={() => record(child, "NOT_ON_VEHICLE")} />
                      <BigButton
                        label="Left early" pressed={askingEarly === riderKey}
                        onClick={() => setAskingEarly(askingEarly === riderKey ? null : riderKey)}
                      />
                    </div>
                  )}
                  {blockedReason !== null && !action ? (
                    <p style={{ color: result.status === "CAPABILITY_PENDING" ? tone.warn.fg : tone.crit.fg, margin: "8px 0 0" }}>
                      {blockedReason}
                    </p>
                  ) : null}
                  {askingEarly === riderKey ? (
                    <div role="group" aria-label={`Who picked up ${child.displayName}?`} style={{ marginTop: 8 }}>
                      <p style={{ margin: "0 0 8px" }}>Who picked up?</p>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {PICKUP_ROLES.map((role) => (
                          <BigButton key={role} label={role} onClick={() => record(child, "LEFT_EARLY", role)} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {queue.length > 0 ? (
            <div style={CARD}>
              <h2 style={{ fontSize: 20, marginTop: 0 }}>Saved on this iPad</h2>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {queue.map((entry) => (
                  <li key={entry.id} style={{ marginBottom: 6 }}>
                    {`${entry.label} · ${entry.at}`}{" "}
                    {entry.offline
                      ? <Chip toneName="warn" icon="offline">Waiting for Wi-Fi</Chip>
                      : <Chip toneName="neutral" icon="check">Saved here only</Chip>}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>

      {/* Sticky feasibility banner, driven by the solver */}
      <div style={{
        position: "sticky", bottom: 0, marginTop: size.gap, background: tone[banner.tone].bg,
        color: tone[banner.tone].fg, border: `1px solid ${tone[banner.tone].fg}`, borderRadius: size.radius,
        padding: size.gap,
      }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 20, fontWeight: 700 }}>
          <Icon name={banner.tone === "ok" ? "check" : banner.tone === "warn" ? "question" : "alert"} size={26} />
          {banner.title}
        </div>
        {banner.detail ? <p style={{ margin: "6px 0 0" }}>{banner.detail}</p> : null}
        {result.options.length > 0 ? (
          <div style={{ marginTop: size.gap, color: color.ink }}>
            <h3 style={{ fontSize: 18, margin: "0 0 8px" }}>What a coordinator can choose</h3>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {result.options.map((option) => (
                <li key={option.id} style={{ marginBottom: 6 }}>
                  <strong>{option.label}</strong> — {option.detail}{" "}
                  <Chip toneName="neutral" icon="question">Needs a coordinator’s approval</Chip>
                </li>
              ))}
            </ol>
            <p style={{ color: color.inkMuted, marginBottom: 0 }}>
              Reported by provider, not checked at the ramp, unless that vehicle was checked here too.
              Ramp staff don’t choose; the coordinator does.
            </p>
          </div>
        ) : null}
      </div>

      <div aria-live="polite" style={{ position: "fixed", bottom: 96, left: size.gap }}>
        {snack ? (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 12, background: color.ink, color: color.surface,
            padding: "12px 16px", borderRadius: size.radius,
          }}>
            {snack.text}
            <button
              type="button" onClick={() => undo(snack)}
              style={{
                background: "transparent", color: color.surface, border: `1px solid ${color.surface}`,
                borderRadius: size.radius, minHeight: 44, padding: "0 14px", fontSize: 16, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit", ...focusRing,
              }}
            >
              Undo
            </button>
          </span>
        ) : null}
      </div>
    </main>
  );
}

/** A rider can only be placed where the four constraints allow (PRD §7). */
function eligibleFor(child: Child, position: LayoutPosition): boolean {
  if (isWc(position)) return child.mobility === "WC" && chairFitsPosition(child, position);
  if (child.mobility !== "AMB") return false;
  return isAmb(position) && (!child.tether || position.tetherCapable);
}
