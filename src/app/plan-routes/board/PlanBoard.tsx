"use client";

/**
 * The plan board (redesign spec §1, BUILD-READY): three van columns, the children waiting beside
 * them, and the map drawing whatever the columns say.
 *
 * What this screen is, in one paragraph. A van is five numbers somebody counted when it arrived
 * (conflict C1, founder's 2026-10-17 2:38 PM ET direction), so every question it answers is
 * arithmetic over those numbers and the needs on each child's approved profile — and that
 * arithmetic is one pure function, `src/domain/plan/fit.ts`, which runs here on every drag, under
 * Auto-plan, and again on the server at save. The capacity solver makes no placement decision
 * anywhere (Firia's rule 2). The plan is kept in `ops.plan_run` / `ops.plan_assignment`
 * (migration 0009), so a save survives a reload and a second browser, which #58's in-memory store
 * could not.
 *
 * The counts themselves are **read only** here: they are confirmed at the ramp iPad, and a count
 * chip is a link to it (Firia's rule 1 — no planned counts on the board, and no write path that
 * could produce one).
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
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Hand } from "lucide-react";
import PlanMap from "@/components/map/PlanMap";
import { useRouter } from "next/navigation";
import { API } from "@/auth/access";
import type { RejectReason } from "@/config/equipment";
import {
  autoPlan,
  boardMap,
  boardRiders,
  needsByToken,
  placedCount,
  ridersToPlace,
  unassignedRiders,
  type Bucket,
  type BoardDay,
  type BoardPlan,
  type BoardRider,
} from "@/domain/plan/board";
import { panelNeedsOf, type PanelNeeds } from "@/domain/plan/needs";
import {
  applyPending,
  clearPending,
  enqueue,
  hasPending,
  movesToSave,
  undoLast,
  NO_PENDING,
  type PendingMove,
  type PendingQueue,
} from "@/domain/plan/pending";
import { eligibility } from "@/domain/plan/eligibility";
import { hhmmOf, minuteOfDay, plannedStopTimes } from "@/domain/plan/arrivals";
import type { BoardView } from "@/modules/plan/store";
import { boardHref } from "@/modules/plan/when";
import { vanColourVar } from "@/config/vans";
import { fill, flow, planBoard, refusal as refusalCopy } from "@/ui/copy";
import { NeedIcons } from "@/ui/equipment";
import { HeaderSlot } from "@/ui/HeaderSlot";
import { serviceDateLabel } from "@/ui/service-date";
import { icon } from "@/ui/tokens";
import { BoardToolbar } from "./BoardToolbar";
import { ChildPanel, whereLine } from "./ChildPanel";
import { UNASSIGNED_ID, UnassignedColumn } from "./UnassignedColumn";
import { VanColumn } from "./VanColumn";
import { ConfirmRestart } from "@/ui/ConfirmRestart";
import { restartStep, sendDemoReset, type RestartStep } from "@/ui/restart-confirm";
import { dropTarget } from "./collision";
import { dropOutcome } from "./drop";
import type { Refusal } from "./refusal";
import { boardBanner, movedLine, type SaveState } from "./lines";
import styles from "./board.module.css";

/** How long the "Mia R. → Van 2 · Undo" toast stays (§1.3's four seconds). */
const TOAST_MS = 4000;

/** This screen's own address, which its leg links point back at with a different `?leg=`. */
const BOARD_PATH = "/plan-routes";

/** The one screen a van is counted on. Its address is in the access table, not invented here. */
const RAMP_PATH = "/ramp-ipad";

export default function PlanBoard({
  view,
  selectedVanId = null,
  canEdit = true,
  canStartDay = false,
}: {
  view: BoardView;
  /**
   * Director and coordinator drag and edit; the front desk reads the same board on Today with
   * no grips and no Save (founder 2026-10-17 7:17 PM ET). The endpoints refuse their role too.
   */
  canEdit?: boolean;
  /**
   * May this caller start the demo day? The director, which is the one role the reset endpoint
   * allows (src/auth/access.ts). The server checks it again; this only decides what is offered.
   */
  canStartDay?: boolean;
  /** 1 where the board is the screen, 2 where it is Today's child list. */
  /**
   * The van the address names (§9.3's `?van=`), which is where the ramp's Re-plan and the
   * board's own "Check vans" round trip come back to: that column is ringed, its route is the one
   * in front on the map, and on a phone it is the column already on screen.
   */
  selectedVanId?: string | null;
}) {
  /* ── the board as the server last answered, and the plan on screen ── */
  const [board, setBoard] = useState<BoardView>(view);
  const [savedPlan, setSavedPlan] = useState<BoardPlan>(view.plan);
  const [version, setVersion] = useState(view.version);
  /** The child whose panel is open, by token. One at a time (mockup plan-board-child-*.png). */
  const [openChild, setOpenChild] = useState<string | null>(null);
  const [savingChild, setSavingChild] = useState(false);
  /** True while "Start demo day" is in flight, so the one button cannot be pressed twice. */
  const [startingDay, setStartingDay] = useState(false);
  /** Which of the two groups the held card is over, so it can say it would take them. */
  const [overBucket, setOverBucket] = useState<Bucket | null>(null);
  const router = useRouter();
  const [save, setSave] = useState<SaveState>(
    view.savedAt ? { kind: "SAVED", at: view.savedAt } : { kind: "DIRTY" },
  );
  /**
   * The moves nobody has saved yet (Firia's option A, 2026-10-17 10:29 PM ET). A drag goes on
   * here and writes nothing; Save sends the whole queue in one transaction; Undo takes the last
   * one back and never touches what is saved.
   */
  const [pending, setPending] = useState<PendingQueue>(NO_PENDING);
  /**
   * Departures changed for today and not saved yet, `{ vanId: "HH:MM" }` (ledger #76). An edit is
   * like a move: it changes every time on that van at once, and Save keeps it.
   */
  const [leaveEdits, setLeaveEdits] = useState<Readonly<Record<string, string>>>({});
  /** The child the pointer is on: the map rings their stop. */
  const [pointed, setPointed] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string } | null>(null);
  /**
   * The one refusal on screen: which card it is on, and the four words it says (Vera's taste
   * spec, 2026-10-18). Not a toast — a refusal is about the card a person is holding, and it
   * stays until the next drag starts rather than sliding away after four seconds.
   */
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [lifted, setLifted] = useState<BoardRider | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [shownColumn, setShownColumn] = useState<string>(selectedVanId ?? UNASSIGNED_ID);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  /** Where "Start demo day" is: idle, asking "Restart today?", or sending the reset. */
  const [restart, setRestart] = useState<RestartStep>("IDLE");

  /*
   * ── the server answered again ──
   *
   * `useState(view)` captures the first answer and keeps it for ever, so after the
   * `router.refresh()` that "Start demo day" ends with, this screen was still holding the day
   * from *before* the reset: the old riders, the old plan, and the old version a Save would have
   * had to name. A new `view` object is a new read of the day, so it replaces all three.
   *
   * Unless there is a draft on this board, which belongs to the coordinator and is never thrown
   * away by a refresh (Firia's option A). The new answer is taken as soon as the draft is: the
   * last-seen view only moves on when it is actually applied, so a skipped refresh is not lost.
   *
   * Adjusted **during the render** rather than in an effect, which is React's own answer for
   * "some state has to change when a prop changes": an effect would paint the stale day first
   * and then replace it (react.dev, "You Might Not Need an Effect").
   */
  const [seenView, setSeenView] = useState(view);
  if (seenView !== view && !hasPending(pending) && Object.keys(leaveEdits).length === 0) {
    setSeenView(view);
    setBoard(view);
    setSavedPlan(view.plan);
    setVersion(view.version);
    setSave(view.savedAt ? { kind: "SAVED", at: view.savedAt } : { kind: "DIRTY" });
    setRefusal(null);
  }

  /**
   * The day exactly as the server read it. The board has no counts of its own to apply: they are
   * confirmed at the ramp and read here (Firia's rule 1), so nothing on this screen can change a
   * van's numbers between the render and the save.
   */
  const day: BoardDay = board.day;

  /** What the screen shows: the saved plan with every unsaved move folded on, in order. */
  const plan: BoardPlan = useMemo(() => applyPending(savedPlan, pending), [savedPlan, pending]);

  const dirty = hasPending(pending) || Object.keys(leaveEdits).length > 0;

  /*
   * ── When each van leaves, and so when every child is picked up or gets home (ledger #76) ──
   * The saved departure, or today's unsaved edit, then the one estimate the late texts and the
   * agent use (`plannedStopTimes`), over the plan on screen — so a move or a new time shows its
   * effect on every child before anybody saves.
   */
  const departs = useMemo(
    () => ({ ...board.departs, ...Object.fromEntries(Object.entries(leaveEdits).map(([id, hhmm]) => [id, minuteOfDay(hhmm) ?? board.departs[id]])) }),
    [board.departs, leaveEdits],
  );
  const times = useMemo(() => plannedStopTimes(day, plan, departs), [day, plan, departs]);
  const focus = useMemo(() => {
    const at = pointed ? plan[pointed] : undefined;
    const rider = pointed ? day.riders.find((r) => r.token === pointed) : undefined;
    return at?.bucket === "VAN" && at.vanId && rider ? { laneId: at.vanId, label: rider.stopLabel } : null;
  }, [pointed, plan, day.riders]);
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

  /*
   * ── while a child is held: what every van would do with them ──
   *
   * The same `eligibility` the drop runs and the same one Auto-plan's placement function asks
   * (src/domain/plan/eligibility.ts). Three call sites, one question: a column that rings itself
   * as able to take the child is a column whose drop will land.
   */
  const rejects: Record<string, RejectReason | null> = useMemo(() => {
    if (!lifted) return {};
    return Object.fromEntries(
      day.vans.map((van) => {
        const verdict = eligibility(day, plan, lifted.token, van.id);
        return [van.id, verdict.ok ? null : verdict.reason];
      }),
    );
  }, [day, plan, lifted]);

  /**
   * One child moved — into a van, out of every van, or onto Absent or Family drives.
   *
   * Every move is **written through the server** and saved as a new plan version (founder
   * 2026-10-17 7:17 PM ET: never a silent overwrite, and it survives a reload). The browser
   * still asks the fit rule first, so a refusal is instant and the card goes back without a
   * round trip; the server asks it again, because a request did not come from this screen.
   */
  const applyPlacement = useCallback(
    (childToken: string, bucket: Bucket, vanId: string | null) => {
      if (!canEdit) return;
      const outcome = dropOutcome(day, plan, childToken, bucket, vanId);
      // A target this board is not drawing: nobody moves and nothing is claimed. This used to
      // fall through to the "→ Unassigned" success toast, which is the S1 report.
      if (outcome.kind === "NOTHING") return;
      if (outcome.kind === "REFUSED") {
        /*
         * Refused before it is even a draft. The card **stays where it was** — it is never put
         * back in Unassigned — and the reason is one coral line on it plus the announced
         * sentence (Vera's taste spec: no toast for a refusal). The server asks again at Save.
         */
        setRefusal({ childToken, reason: outcome.reason, line: outcome.line });
        setAnnouncement(outcome.announce);
        return;
      }

      setPending((queue) => enqueue(queue, { childToken, bucket, vanId: outcome.vanId }));
      setToast({ text: outcome.toast });
      setAnnouncement(outcome.announce);
      /*
       * Nothing is written: the board is a draft until Save (option A). The last save's stamp
       * is left as it is, so undoing every unsaved move puts "Saved <time>" back on the chip
       * rather than leaving a board that is saved looking dirty for ever. The chip is derived
       * from the queue where it is rendered, below.
       */
    },
    [canEdit, day, plan],
  );

  const applyMove = useCallback(
    (childToken: string, vanId: string | null) => {
      void applyPlacement(childToken, vanId === null ? "UNASSIGNED" : "VAN", vanId);
    },
    [applyPlacement],
  );

  const applyBucket = useCallback(
    (childToken: string, bucket: Bucket) => {
      void applyPlacement(childToken, bucket, null);
    },
    [applyPlacement],
  );

  /**
   * The child panel's Save: three Yes/No answers, written to the child's approved profile, and
   * the leg re-planned on them (src/modules/plan/api.ts `setChildNeedsRequest`). The board that
   * comes back is the plan as it now is — which is the whole point of the control.
   */
  const saveChildNeeds = useCallback(
    async (childToken: string, panel: PanelNeeds) => {
      setSavingChild(true);
      try {
        const response = await fetch(childNeedsPath(childToken), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ date: day.date, direction: day.direction, version, ...panel }),
        });
        const body = (await response.json().catch(() => null)) as
          | { ok?: boolean; version?: number; savedAt?: string; reason?: string; changedBy?: string | null; childToken?: string; view?: BoardView }
          | null;
        if (response.ok && body?.ok && body.view && typeof body.version === "number") {
          setBoard(body.view);
          setSavedPlan(body.view.plan);
          setVersion(body.version);
          setSave({ kind: "SAVED", at: body.savedAt ?? new Date().toISOString() });
          setOpenChild(null);
          return;
        }
        if (response.status === 409 && body?.reason === "CHANGED") {
          setSave({ kind: "CHANGED", by: body.changedBy ?? null });
          return;
        }
        if (response.status === 422 && body?.reason === "OUTSIDE_SLOT") {
          setSave({ kind: "OUTSIDE_SLOT", child: nameOf(day, body.childToken ?? "") || refusalCopy.aChild });
          return;
        }
        setSave({ kind: "FAILED" });
      } catch {
        setSave({ kind: "FAILED" });
      } finally {
        setSavingChild(false);
      }
    },
    [day, version],
  );

  /** Undo takes back the most recent **unsaved** move, and only that (option A). */
  /*
   * ── "Start demo day": the same reset the DEMO bar calls, from the strip that is waiting on it ──
   *
   * And the same question in front of it (Vera's copy, 2026-10-18): a reset clears the saved plan
   * for every van the day runs — `day.vans`, which is what the dialog's own sentence counts — so
   * with a plan saved for today the press opens "Restart today?" first —
   * the one dialog and the one decision both controls share (src/ui/ConfirmRestart.tsx,
   * src/ui/restart-confirm.ts). "A plan is saved" is the version the server gave this board,
   * which is the same fact its own Save chip stands on; nothing new is read.
   */
  const hasSavedPlan = version > 0;

  const sendReset = useCallback(async () => {
    setStartingDay(true);
    try {
      // The day on screen is the old one either way: a refusal is the server's answer to read,
      // and a success is a new day to re-read. Both are a refresh.
      if (await sendDemoReset()) router.refresh();
    } catch {
      // Nothing to recover from and nothing to report: the strip still says the day is not
      // started, which is the honest state of it.
    } finally {
      setStartingDay(false);
      setRestart("IDLE");
    }
  }, [router]);

  const startDay = useCallback(() => {
    const next = restartStep("PRESS", hasSavedPlan);
    setRestart(next.step);
    if (next.send) void sendReset();
  }, [hasSavedPlan, sendReset]);

  /** "Keep plan" closes the dialog and sends nothing; "Restart" posts the existing reset. */
  const answerRestart = useCallback(
    (event: "KEEP" | "RESTART") => {
      const next = restartStep(event, true);
      setRestart(next.step);
      if (next.send) void sendReset();
    },
    [sendReset],
  );

  const undo = useCallback(() => {
    setPending((queue) => undoLast(queue));
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

  /* ── saving: every pending move, in one transaction (option A) ── */
  const onSave = useCallback(async () => {
    const moves = movesToSave(savedPlan, pending);
    if (moves.length === 0 && Object.keys(leaveEdits).length === 0) return;
    setSave({ kind: "SAVING" });
    try {
      const response = await fetch(API.planSave, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: day.date, direction: day.direction, version, moves, departures: leaveEdits }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; version?: number; savedAt?: string; reason?: string; changedBy?: string | null; childToken?: string; view?: BoardView }
        | null;
      if (response.ok && body?.ok && typeof body.version === "number") {
        if (body.view) setBoard(body.view);
        setSavedPlan(body.view ? body.view.plan : plan);
        setVersion(body.version);
        setPending(clearPending());
        if (!body.view) setBoard((current) => ({ ...current, departs }));
        setLeaveEdits({});
        setSave({ kind: "SAVED", at: body.savedAt ?? new Date().toISOString() });
        return;
      }
      if (response.status === 422 && body?.reason === "OUTSIDE_SLOT") {
        setSave({ kind: "OUTSIDE_SLOT", child: nameOf(day, body.childToken ?? "") || refusalCopy.aChild });
        return;
      }
      if (response.status === 409) {
        // Somebody else moved the plan on. The queue is **kept** — it is this coordinator's
        // draft — and the screen asks for a reload (Firia, 10:29 PM ET).
        setSave({ kind: "CHANGED", by: body?.changedBy ?? null });
        return;
      }
      setSave({ kind: "FAILED" });
    } catch {
      setSave({ kind: "FAILED" });
    }
  }, [day, departs, leaveEdits, pending, plan, savedPlan, version]);

  /*
   * There is no "Save anyway?" (Veri, 2026-10-17 8:35 PM ET): a van can never be saved over its
   * own counts, so the only answer to an over-capacity board is to move somebody, and the
   * server refuses it with the same 422 a drag gets.
   */
  const trySave = useCallback(() => {
    void onSave();
  }, [onSave]);

  /* ── the drag itself ── */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = (event: DragStartEvent) => {
    // Every child on the board, not only the ones this leg drives: a family-drives card lifts
    // like any other, so it needs its overlay and its pre-check (Firia, 2026-10-18).
    const rider = boardRiders(day).find((r) => r.token === String(event.active.id));
    setLifted(rider ?? null);
    setToast(null);
    // The last refusal is answered by picking the card up again (Vera: it clears on drag start).
    setRefusal(null);
  };
  const onDragOver = (event: DragOverEvent) => {
    const over = event.over ? String(event.over.id) : null;
    setHovered(over);
    setOverBucket(over === "ABSENT" || over === "FAMILY_DRIVES" ? (over as Bucket) : null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const childToken = String(event.active.id);
    const target = event.over ? String(event.over.id) : null;
    setLifted(null);
    setHovered(null);
    setOverBucket(null);
    if (!target) return;
    if (target === "ABSENT" || target === "FAMILY_DRIVES") {
      applyBucket(childToken, target);
      return;
    }
    applyMove(childToken, target === UNASSIGNED_ID ? null : target);
  };

  const banner = boardBanner(
    view.readiness,
    firstUncheckedHref(day, day.date, day.direction),
    canStartDay,
  );

  return (
    <main className={styles.page}>
      <DndContext
        sensors={sensors}
        /*
         * Where a drop lands is the **pointer**, not the dragged card's centre: `closestCenter`
         * gave a drop on Van 1's left half to the column the card came from, which is the S1
         * bounce (src/app/plan-routes/board/collision.ts, and the rects in its test).
         */
        collisionDetection={dropTarget}
        /*
         * dnd-kit's own live region announces the thing being dragged, and by default it reads the
         * draggable's **id** — which on this board is a child token. A screen reader would spell a
         * uuid out loud, and §9.3's rule is that an id never reaches a screen at all. So the
         * announcements are ours: the child's name, the van's name, and nothing else.
         */
        accessibility={{
          announcements: {
            onDragStart: ({ active }) => nameOf(day, String(active.id)),
            onDragOver: ({ active, over }) =>
              over ? movedLine(nameOf(day, String(active.id)), nameOfColumn(day, String(over.id))) : undefined,
            onDragEnd: ({ active, over }) =>
              over ? movedLine(nameOf(day, String(active.id)), nameOfColumn(day, String(over.id))) : undefined,
            onDragCancel: ({ active }) => nameOf(day, String(active.id)),
          },
        }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setLifted(null);
          setHovered(null);
          setOverBucket(null);
        }}
      >
        {/*
          The board's controls ride in the frame's 64 px header bar, beside the one `h1` it
          draws (src/ui/HeaderSlot.tsx, #74/#77): per plan-board.png the date, Morning |
          Afternoon, the placed count, Undo, Auto-plan and Save are all on that row, not in a
          second strip under it. The frame knows nothing about them — it owns a slot.
        */}
        <HeaderSlot>
          <BoardToolbar
            dateLabel={serviceDateLabel(new Date(`${day.date}T12:00:00Z`))}
            direction={day.direction}
            hrefFor={(next) => boardHref(BOARD_PATH, { date: day.date, leg: next })}
            placed={placed}
            total={ridersToPlace(day, plan).length}
            save={dirty && save.kind === "SAVED" ? { kind: "DIRTY" } : save}
            canUndo={hasPending(pending)}
            onUndo={undo}
            onAutoPlan={() => {
              // Auto-plan proposes: its answer becomes unsaved moves, like a drag, and nothing
              // is written until Save (option A).
              const planned = autoPlan(day, plan);
              setPending((queue) =>
                movesToSave(savedPlan, [...queue, ...asMoves(plan, planned)]).reduce(
                  (next, move) => enqueue(next, move),
                  NO_PENDING,
                ),
              );
            }}
            autoPlanPrimary={placed === 0}
            onSave={trySave}
            canSave={day.riders.length > 0 && (dirty || save.kind === "FAILED")}
          />
        </HeaderSlot>

        {banner ? (
          <p className={styles.banner} data-tone={banner.tone} data-banner="">
            {banner.text}
            {banner.action && "start" in banner.action ? (
              /*
                The one button this strip has, and only for the role the reset endpoint allows
                (Firia's final scope, 2026-10-18 1:50 AM ET). It calls the same path the DEMO
                bar's "Restart demo day" calls — `POST /api/demo/reset`, DIRECTOR and
                site-scoped — so the server is still the thing that decides, and the screen
                re-reads the day it just started.
              */
              <button
                type="button"
                className={styles.bannerButton}
                data-start-day=""
                disabled={startingDay || restart !== "IDLE"}
                onClick={startDay}
              >
                {banner.action.label}
              </button>
            ) : banner.action ? (
              <a className={styles.bannerLink} href={banner.action.href} data-banner-link="">
                {banner.action.label}
              </a>
            ) : null}
          </p>
        ) : null}

        {/*
          One column at a time on a phone (§9.3); the switcher is hidden on a wide screen.

          Chips, as png/plan-board-390.png draws them — each van's own colour as a dot beside
          its name, and Unassigned with how many are still waiting — and not the leg switch's
          segmented control, which Vera's 390 pass found them wearing.
        */}
        <div className={styles.switcher} role="tablist" aria-label={planBoard.columnSwitcher}>
          {[
            {
              id: UNASSIGNED_ID,
              name: fill(planBoard.switcherUnassigned, {
                name: planBoard.unassigned,
                n: waiting.length,
              }),
              colour: null as string | null,
            },
            ...day.vans.map((van) => ({
              id: van.id,
              name: van.name,
              colour: vanColourVar(van.colourToken),
            })),
          ].map((column) => (
            <button
              key={column.id}
              type="button"
              role="tab"
              className={styles.vanTab}
              aria-selected={shownColumn === column.id}
              onClick={() => setShownColumn(column.id)}
            >
              {column.colour ? (
                <span
                  className={styles.swatch}
                  style={{ background: column.colour }}
                  aria-hidden="true"
                />
              ) : null}
              {column.name}
            </button>
          ))}
        </div>

        {/*
          How a card moves where there is no pointer to right-click with (png/plan-board-390.png).
          One line above the columns, shown only at 390, instead of a `Move to…` select printed
          under every card — which is what doubled the Family drives lane's height.
        */}
        {canEdit ? (
          <p className={styles.moveHint} data-move-hint="">
            <Hand size={icon.chip} aria-hidden="true" />
            {planBoard.holdToMove}
          </p>
        ) : null}

        <div className={styles.body}>
          <div className={styles.columns}>
            <UnassignedColumn
              day={day}
              plan={plan}
              shown={shownColumn === UNASSIGNED_ID}
              columns={columns}
              onMove={applyMove}
              onMoveToBucket={applyBucket}
              onOpenChild={setOpenChild}
              canEdit={canEdit}
              overBucket={overBucket}
              lifted={Boolean(lifted)}
              refusal={refusal}
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
                selected={selectedVanId === van.id}
                shown={shownColumn === van.id}
                columns={columns}
                onMove={applyMove}
                onMoveToBucket={applyBucket}
                onOpenChild={setOpenChild}
                canEdit={canEdit}
                openChildToken={openChild}
                refusal={refusal}
                rampHref={rampHref(van.id, day.date, day.direction)}
                leaves={hhmmOf(departs[van.id] ?? 0)}
                onLeaves={(hhmm) => setLeaveEdits((edits) => ({ ...edits, [van.id]: hhmm }))}
                times={times}
                onPointChild={setPointed}
              />
            ))}
          </div>

          {/*
            The map is a landmark of its own, named in two words (§1.5's `mapLabel`), so a screen
            reader can jump to it and a review can measure where it is. It draws `boardMap(day,
            plan)` — the same plan the columns are rendered from, in the same render — so a child
            moved between columns moves on the map rather than in a copy kept in step by hand.
          */}
          <aside className={styles.map} aria-label={planBoard.mapLabel}>
            <PlanMap data={map} selectedLaneId={hovered ?? selectedVanId} onSelect={() => undefined} focus={focus} />
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

      {openChild ? (
        <ChildPanel
          childName={nameOf(day, openChild)}
          where={whereLine(
            vanNameOfChild(day, plan, openChild),
            plan[openChild]?.bucket ?? "UNASSIGNED",
            day.direction,
          )}
          needs={panelNeedsOf(
            needsByToken(day, openChild) ?? {
              wheelchair: false,
              carSeat: false,
              oxygen: false,
              nurse: false,
            },
          )}
          canEdit={canEdit}
          saving={savingChild}
          onSave={(next) => void saveChildNeeds(openChild, next)}
          onClose={() => setOpenChild(null)}
        />
      ) : null}

      {toast ? (
        <p className={styles.toast} data-toast="">
          {toast.text}
          <button type="button" className={styles.toastUndo} onClick={undo}>
            {planBoard.undo}
          </button>
        </p>
      ) : null}

      {/*
        "Restart today?" — the same question, in the same words, as the DEMO bar's own control
        (Vera's copy). The bar's "Restart demo day" and this strip's "Start demo day" are
        deliberately nowhere near each other and nothing alike: one is an outlined pill on the
        violet chrome, the other the underlined word inside this sentence.
      */}
      {restart === "ASKING" ? (
        <ConfirmRestart
          onKeep={() => answerRestart("KEEP")}
          onRestart={() => answerRestart("RESTART")}
          /*
            How many vans the question is about, from this day's own van data rather than a
            number in the copy (Veri's S2 on #79): these are the columns on screen, and a day
            running two of them says "both vans".
          */
          vanCount={day.vans.length}
          busy={startingDay}
        />
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
    </main>
  );
}

/** The name of any child on the day, rider or not — never an id (§9.3). */
function nameOf(day: BoardDay, token: string): string {
  return boardRiders(day).find((rider) => rider.token === token)?.name ?? "";
}

/** Which van this child is in right now, by name, or null for "in none of them". */
function vanNameOfChild(day: BoardDay, plan: BoardPlan, token: string): string | null {
  const vanId = plan[token]?.vanId ?? null;
  return day.vans.find((van) => van.id === vanId)?.name ?? null;
}

/** The child-needs endpoint for one child, from the access table's own template. */
function childNeedsPath(childToken: string): string {
  return API.childNeeds.replace("[token]", encodeURIComponent(childToken));
}

/** The difference between two plans, as the moves that would make it — what Auto-plan proposes. */
function asMoves(before: BoardPlan, after: BoardPlan): PendingMove[] {
  const moves: PendingMove[] = [];
  for (const [token, placement] of Object.entries(after)) {
    const was = before[token];
    if (was && was.bucket === placement.bucket && was.vanId === placement.vanId) continue;
    // Auto-plan's answer, not a person's: saved unpinned, so the next Auto-plan may move it.
    moves.push({ childToken: token, bucket: placement.bucket, vanId: placement.vanId, planned: true });
  }
  return moves;
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
 * Where a van's count chip goes: the ramp iPad, on that van and that day (§9.3's `?van=`, and
 * the 5:55 PM ET re-cut of §1.2 — counts are set there and read here).
 */
function rampHref(vanId: string, date: string, leg: "AM" | "PM"): string {
  return boardHref(RAMP_PATH, { date, leg, van: vanId });
}
