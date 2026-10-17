"use client";

/**
 * The plan board (redesign spec §1, BUILD-READY): three van columns, the children waiting beside
 * them, and the map drawing whatever the columns say.
 *
 * What this screen is, in one paragraph. A van is five numbers somebody counted when it arrived
 * (conflict C1, founder's 2026-10-17 2:38 PM ET direction), so every question it answers is
 * arithmetic over those numbers and the needs on each child's approved profile — and that
 * arithmetic is one pure function, `src/domain/plan/fit.ts`, which runs here on every drag and
 * again on the server at save. Auto-plan is the existing capacity solver wrapped round the same
 * counts (§1.4). The plan is kept in `ops.plan_run` / `ops.plan_assignment` (migration 0009), so
 * a save survives a reload and a second browser, which #58's in-memory store could not.
 *
 * What it does *not* do: nothing here sends anything, nothing is locked, and nothing is assigned
 * by a rule the fit function did not agree with. The DEMO bar and the one Simulated chip come
 * from the root layout, so this page must not mount a second pair.
 *
 * Accessibility, which is most of the work: a drag has three cues and never colour alone (§0's
 * rule 2), every refusal is announced as a sentence in an `aria-live` region (§1.3), and the whole
 * board is operable from the keyboard — dnd-kit's keyboard sensor lifts a card on Space, moves it
 * between columns with the arrows and drops it on Space (§1.7 #4), with `Move to…` as the same
 * move for a pointer or a phone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import PlanMap from "@/components/map/PlanMap";
import { API } from "@/auth/access";
import type { RejectReason } from "@/config/equipment";
import {
  autoPlan,
  boardMap,
  moveTo,
  placedCount,
  ridersInVan,
  unassignedRiders,
  type BoardDay,
  type BoardPlan,
  type BoardRider,
} from "@/domain/plan/board";
import { isOver, rejectReason, type VanSetup } from "@/domain/plan/fit";
import type { BoardView } from "@/modules/plan/store";
import { boardHref } from "@/modules/plan/when";
import { flow, planBoard } from "@/ui/copy";
import { NeedIcons } from "@/ui/equipment";
import { serviceDateLabel } from "@/ui/service-date";
import { icon } from "@/ui/tokens";
import { BoardToolbar } from "./BoardToolbar";
import { UNASSIGNED_ID, UnassignedColumn } from "./UnassignedColumn";
import { VanColumn } from "./VanColumn";
import { VanSetupPopover } from "./VanSetupPopover";
import { boardBanner, movedLine, rejectSr, overConfirm, type SaveState } from "./lines";
import styles from "./board.module.css";

/** How long the "Mia R. → Van 2 · Undo" toast stays (§1.3's four seconds). */
const TOAST_MS = 4000;

/** This screen's own address, which its leg links point back at with a different `?leg=`. */
const BOARD_PATH = "/plan-routes";

export default function PlanBoard({ view }: { view: BoardView }) {
  /* ── the plan, and the setups a coordinator has applied on top of the day ── */
  const [plan, setPlan] = useState<BoardPlan>(view.plan);
  const [setups, setSetups] = useState<Record<string, VanSetup>>({});
  const [savedPlan, setSavedPlan] = useState<BoardPlan>(view.plan);
  const [version, setVersion] = useState(view.version);
  const [save, setSave] = useState<SaveState>(
    view.savedAt ? { kind: "SAVED", at: view.savedAt } : { kind: "DIRTY" },
  );
  const [undoStack, setUndoStack] = useState<BoardPlan[]>([]);
  const [toast, setToast] = useState<{ text: string; before: BoardPlan } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [openSetup, setOpenSetup] = useState<string | null>(null);
  const [lifted, setLifted] = useState<BoardRider | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [shownColumn, setShownColumn] = useState<string>(UNASSIGNED_ID);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);

  /** The day with whatever a coordinator has applied in the setup popover. */
  const day: BoardDay = useMemo(
    () => ({
      ...view.day,
      vans: view.day.vans.map((van) =>
        setups[van.id] ? { ...van, setup: setups[van.id], setupState: "PLANNED" as const } : van,
      ),
    }),
    [view.day, setups],
  );

  const dirty = useMemo(() => fingerprint(plan) !== fingerprint(savedPlan), [plan, savedPlan]);
  const placed = placedCount(day, plan);
  const waiting = unassignedRiders(day, plan);
  const map = useMemo(() => boardMap(day, plan), [day, plan]);

  /** Every column a child can be moved to, for the `Move to…` control (§1.2, §9.3). */
  const columns = useMemo(
    () => [
      { id: null as string | null, name: planBoard.unassigned },
      ...day.vans.map((van) => ({ id: van.id as string | null, name: van.name })),
    ],
    [day.vans],
  );

  /* ── while a child is held: what every van would do with them ── */
  const rejects: Record<string, RejectReason | null> = useMemo(() => {
    if (!lifted) return {};
    return Object.fromEntries(
      day.vans.map((van) => [van.id, rejectReason(van.setup, ridersInVan(day, plan, van.id), lifted)]),
    );
  }, [day, plan, lifted]);

  /**
   * Who the setup popover's live line is about (§1.2's `FitPreview`).
   *
   * The child being held, if one is — that is the question a coordinator opened the popover to
   * answer. Otherwise the first child still waiting that **this van cannot take**, because "will
   * raising this help?" is a question about a refusal; and if the van can take everybody, the
   * first one waiting. Chosen from the van's *saved* counts rather than the draft, so the subject
   * does not change under the steppers as they are pressed.
   */
  const previewFor = useCallback(
    (vanId: string): BoardRider | null => {
      if (lifted) return lifted;
      const van = day.vans.find((candidate) => candidate.id === vanId);
      if (!van) return null;
      const aboard = ridersInVan(day, plan, van.id);
      return waiting.find((rider) => rejectReason(van.setup, aboard, rider) !== null) ?? waiting[0] ?? null;
    },
    [day, plan, lifted, waiting],
  );

  const applyMove = useCallback(
    (childToken: string, vanId: string | null) => {
      const rider = day.riders.find((r) => r.token === childToken);
      if (!rider) return;
      const van = vanId ? day.vans.find((v) => v.id === vanId) : null;
      if (van) {
        const reason = rejectReason(van.setup, ridersInVan(day, plan, van.id), rider);
        if (reason) {
          // Refused: the card goes back where it was and the reason is said, not only drawn.
          setAnnouncement(rejectSr(rider.name, van.name, reason));
          return;
        }
      }
      const before = plan;
      const next = moveTo(plan, childToken, vanId);
      setPlan(next);
      setUndoStack((stack) => [...stack, before]);
      setToast({ text: movedLine(rider.name, van ? van.name : planBoard.unassigned), before });
      setAnnouncement(movedLine(rider.name, van ? van.name : planBoard.unassigned));
      if (save.kind === "SAVED") setSave({ kind: "DIRTY" });
    },
    [day, plan, save.kind],
  );

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const previous = stack[stack.length - 1];
      if (previous) setPlan(previous);
      return stack.slice(0, -1);
    });
    setToast(null);
  }, []);

  /* ── the toast clears itself ── */
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  /* ── ⌘Z / Ctrl+Z, which is the undo button's own shortcut (§1.2) ── */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  /*
   * ── Unsaved changes (§9.2) ──
   *
   * A board with a change nobody has saved asks before it is left — the browser's own dialog on a
   * close or a reload, and our own on any link inside the app, so the answer can be "Stay" and
   * "Leave" in words rather than OK and Cancel. The listener is on the document in the capture
   * phase, which is how it catches a click on the menu without this screen knowing anything about
   * the menu (the rail is PR #64's; this does not touch it).
   */
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (!dirtyRef.current) return;
      const anchor = (event.target as HTMLElement | null)?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.getAttribute("href") ?? "";
      // Anything inside the app that is not the view already on screen — which includes the
      // other leg of this day, because switching legs loads a different board and would drop
      // the change with it.
      const here = `${window.location.pathname}${window.location.search}`;
      if (!href.startsWith("/") || href === here) return;
      event.preventDefault();
      setLeaveTo(href);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  /* ── saving ── */
  const vansOver = day.vans.filter((van) => isOver(van.setup, ridersInVan(day, plan, van.id)));

  const onSave = useCallback(
    async (allowOver: boolean) => {
      setSave({ kind: "SAVING" });
      try {
        const response = await fetch(API.planSave, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            date: day.date,
            direction: day.direction,
            version,
            placements: plan,
            ...(allowOver ? { allowOver: true } : {}),
          }),
        });
        const body = (await response.json().catch(() => null)) as
          | { ok?: boolean; version?: number; savedAt?: string; reason?: string; changedBy?: string | null }
          | null;
        if (response.ok && body?.ok && typeof body.savedAt === "string" && typeof body.version === "number") {
          setVersion(body.version);
          setSavedPlan(plan);
          setSave({ kind: "SAVED", at: body.savedAt });
          return;
        }
        if (response.status === 409 && body?.reason === "CHANGED") {
          setSave({ kind: "CHANGED", by: body.changedBy ?? null });
          return;
        }
        setSave({ kind: "FAILED" });
      } catch {
        setSave({ kind: "FAILED" });
      }
    },
    [day.date, day.direction, plan, version],
  );

  const trySave = useCallback(() => {
    if (vansOver.length > 0) {
      // The one confirm this screen asks for (§1.3): a van over its own counts still saves,
      // because the ramp check is what stops anybody boarding — but a person says so first.
      if (!window.confirm(overConfirm(vansOver[0].name))) return;
      void onSave(true);
      return;
    }
    void onSave(false);
  }, [onSave, vansOver]);

  /* ── applying a setup (§1.3 "Setup open") ── */
  const applySetup = useCallback(
    async (vanId: string, setup: VanSetup) => {
      setSetups((current) => ({ ...current, [vanId]: setup }));
      setOpenSetup(null);
      try {
        await fetch(vanSetupPath(vanId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ date: day.date, ...setup, state: "PLANNED" }),
        });
      } catch {
        // The counts are on screen either way; the next load reads whatever the server kept.
      }
    },
    [day.date],
  );

  /* ── the drag itself ── */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = (event: DragStartEvent) => {
    const rider = day.riders.find((r) => r.token === String(event.active.id));
    setLifted(rider ?? null);
    setToast(null);
  };
  const onDragOver = (event: DragOverEvent) => setHovered(event.over ? String(event.over.id) : null);
  const onDragEnd = (event: DragEndEvent) => {
    const childToken = String(event.active.id);
    const target = event.over ? String(event.over.id) : null;
    setLifted(null);
    setHovered(null);
    if (!target) return;
    applyMove(childToken, target === UNASSIGNED_ID ? null : target);
  };

  const banner = boardBanner(view.readiness, firstUncheckedHref(day, day.date, day.direction));

  return (
    <div className={styles.page}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        /*
         * dnd-kit's own live region announces the thing being dragged, and by default it reads the
         * draggable's **id** — which on this board is a child token. A screen reader would spell a
         * uuid out loud, and §9.3's rule is that an id never reaches a screen at all. So the
         * announcements are ours: the child's name, the van's name, and nothing else.
         */
        accessibility={{
          announcements: {
            onDragStart: ({ active }) => nameOfRider(day, String(active.id)),
            onDragOver: ({ active, over }) =>
              over ? movedLine(nameOfRider(day, String(active.id)), nameOfColumn(day, String(over.id))) : undefined,
            onDragEnd: ({ active, over }) =>
              over ? movedLine(nameOfRider(day, String(active.id)), nameOfColumn(day, String(over.id))) : undefined,
            onDragCancel: ({ active }) => nameOfRider(day, String(active.id)),
          },
        }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setLifted(null);
          setHovered(null);
        }}
      >
        <BoardToolbar
          dateLabel={serviceDateLabel(new Date(`${day.date}T12:00:00Z`))}
          direction={day.direction}
          hrefFor={(next) => boardHref(BOARD_PATH, { date: day.date, leg: next })}
          placed={placed}
          total={day.riders.length}
          save={dirty && save.kind === "SAVED" ? { kind: "DIRTY" } : save}
          canUndo={undoStack.length > 0}
          onUndo={undo}
          onAutoPlan={() => {
            setUndoStack((stack) => [...stack, plan]);
            setPlan(autoPlan(day, plan));
          }}
          autoPlanPrimary={placed === 0}
          onSave={trySave}
          canSave={day.riders.length > 0 && (dirty || save.kind === "FAILED")}
        />

        {banner ? (
          <p className={styles.banner} data-tone={banner.tone} data-banner="">
            {banner.text}
            {banner.action ? (
              <a className={styles.bannerLink} href={banner.action.href}>
                {banner.action.label}
              </a>
            ) : null}
          </p>
        ) : null}

        {/* One column at a time on a phone (§9.3); the switcher is hidden on a wide screen. */}
        <div className={styles.switcher} role="tablist" aria-label={planBoard.columnSwitcher}>
          {[{ id: UNASSIGNED_ID, name: `${planBoard.unassigned} ${waiting.length}` }, ...day.vans.map((van) => ({ id: van.id, name: van.name }))].map(
            (column) => (
              <button
                key={column.id}
                type="button"
                role="tab"
                className={styles.segment}
                aria-selected={shownColumn === column.id}
                onClick={() => setShownColumn(column.id)}
              >
                {column.name}
              </button>
            ),
          )}
        </div>

        <div className={styles.body}>
          <div className={styles.columns}>
            <UnassignedColumn
              day={day}
              plan={plan}
              shown={shownColumn === UNASSIGNED_ID}
              columns={columns}
              onMove={applyMove}
            />
            {day.vans.map((van) => (
              <VanColumn
                key={van.id}
                van={van}
                day={day}
                plan={plan}
                minutes={map.routes.find((route) => route.laneId === van.id)?.minutes ?? 0}
                reject={lifted ? rejects[van.id] : undefined}
                hovered={hovered === van.id}
                shown={shownColumn === van.id}
                columns={columns}
                onMove={applyMove}
                setupOpen={openSetup === van.id}
                onOpenSetup={() => setOpenSetup((open) => (open === van.id ? null : van.id))}
              >
                {openSetup === van.id ? (
                  <VanSetupPopover
                    van={van}
                    aboard={ridersInVan(day, plan, van.id)}
                    preview={previewFor(van.id)}
                    onApply={(setup) => void applySetup(van.id, setup)}
                    onCancel={() => setOpenSetup(null)}
                  />
                ) : null}
              </VanColumn>
            ))}
          </div>

          {/*
            The map is a landmark of its own, named in two words (§1.5's `mapLabel`), so a screen
            reader can jump to it and a review can measure where it is. It draws `boardMap(day,
            plan)` — the same plan the columns are rendered from, in the same render — so a child
            moved between columns moves on the map rather than in a copy kept in step by hand.
          */}
          <aside className={styles.map} aria-label={planBoard.mapLabel}>
            <PlanMap data={map} selectedLaneId={hovered} onSelect={() => undefined} />
          </aside>
        </div>

        <DragOverlay>
          {lifted ? (
            <div className={styles.overlayCard}>
              {lifted.name}
              <NeedIcons needs={lifted.needs} size={icon.chip} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Every refusal and every move, said once, where a screen reader will read it (§1.3). */}
      <p className="srOnly" role="status" aria-live="polite" data-announce="">
        {announcement}
      </p>

      {toast ? (
        <p className={styles.toast} data-toast="">
          {toast.text}
          <button type="button" className={styles.toastUndo} onClick={undo}>
            {planBoard.undo}
          </button>
        </p>
      ) : null}

      {leaveTo ? (
        <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={flow.leave.title}>
          <div className={styles.dialogCard}>
            <h2 className={styles.dialogTitle}>{flow.leave.title}</h2>
            <div className={styles.popoverActions}>
              <button
                type="button"
                className={styles.button}
                data-variant="primary"
                onClick={() => setLeaveTo(null)}
              >
                {flow.leave.stay}
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  // A full navigation rather than a client one: the board is leaving either way,
                  // and this is the one place the unsaved-change guard is deliberately stood down.
                  setSavedPlan(plan);
                  setLeaveTo(null);
                  window.location.assign(leaveTo);
                }}
              >
                {flow.leave.leave}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A rider's own name, for an announcement that must not contain an id. */
function nameOfRider(day: BoardDay, token: string): string {
  return day.riders.find((rider) => rider.token === token)?.name ?? "";
}

/** A column's own name: a van's number, or the group at the top of the board. */
function nameOfColumn(day: BoardDay, id: string): string {
  return day.vans.find((van) => van.id === id)?.name ?? planBoard.unassigned;
}

/** The plan as one string, so "is there a change nobody has saved" is a comparison, not a flag. */
function fingerprint(plan: BoardPlan): string {
  return Object.entries(plan)
    .map(([token, placement]) => `${token}:${placement.bucket}:${placement.vanId ?? ""}`)
    .sort()
    .join("|");
}

/** Where "Check vans" goes: the ramp iPad, on the first van nobody has confirmed today (§9.6 #4). */
function firstUncheckedHref(day: BoardDay, date: string, leg: "AM" | "PM"): string | null {
  const van = day.vans.find((candidate) => candidate.setupState !== "CHECKED");
  if (!van) return null;
  return boardHref("/ramp-ipad", { date, leg, van: van.id });
}

/**
 * The van-setup endpoint for one van, built from the access table's own template rather than
 * written out here: a screen may not contain an `/api/...` literal at all
 * (src/ui/no-internals.test.ts), and the table is where every one of them lives.
 */
function vanSetupPath(vanId: string): string {
  return API.vanSetup.replace("[id]", encodeURIComponent(vanId));
}
