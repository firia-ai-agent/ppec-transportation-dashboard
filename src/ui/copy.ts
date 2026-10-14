/**
 * Every user-facing string the app renders. Source of truth: COPY-GUIDE.md
 * (§5 microcopy per surface, §6 banner text, §6.1 source-mode labels) and
 * DESIGN-DIRECTION.md §2 (nav), §3 (state labels, which live in states.ts).
 *
 * Components must not contain user-facing string literals; a copy change is a change here.
 * Voice: calm, plain, child-first, honest about certainty (COPY-GUIDE §1).
 */

/**
 * Fills `{name}` placeholders. Keys may contain spaces, because some §3 labels are written
 * that way ("Handed off to {receiver role}", "Staff: {first name}"). Unknown placeholders are
 * left in place so a missing value is visible in review instead of printing "undefined".
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * Closes a sentence with exactly one full stop. Needed because §3 writes a child as first name
 * plus last initial ("Leo B."), so a template that supplied its own period would print "Leo B..".
 */
export function sentence(text: string): string {
  return /[.?\u2026]$/.test(text) ? text : `${text}.`;
}

export const app = {
  /** Site name in the header. */
  siteName: "PPEC transportation",
  /** <title> */
  documentTitle: "PPEC transportation dashboard",
  skipToContent: "Skip to content",
} as const;

/**
 * COPY-GUIDE §6 (founder, 2026-10-14 13:18 ET, ledger row 40): the banner reads exactly
 * "DEMO", and that decision covers the screen-reader label too — COPY-GUIDE §6 and
 * DESIGN-DIRECTION §7 both fix it as aria-label "DEMO", announced once on load.
 */
export const demoBanner = {
  text: "DEMO",
  ariaLabel: "DEMO",
} as const;

/** DESIGN-DIRECTION §2 nav labels. Exceptions carries a count badge once the live board lands. */
export const nav = {
  today: "Today",
  exceptions: "Exceptions & Approvals",
  setup: "Setup",
  health: "Health & ROI",
  landmarkLabel: "Main",
  openMenu: "Open menu",
  closeMenu: "Close menu",
  menuLabel: "Menu",
} as const;

/** COPY-GUIDE §5: visible label "Search", placeholder "Child, route or vehicle". */
export const search = {
  label: "Search",
  placeholder: "Child, route or vehicle",
  submit: "Search",
} as const;

export const identity = {
  menuLabel: "Account",
  signOut: "Sign out",
  signedInAs: "Signed in as {name}",
} as const;

/**
 * COPY-GUIDE §5 header: freshness pills read "<adapter> · Simulated" until the live board
 * wires real ages.
 */
export const adapters = {
  sms: "SMS",
  teams: "Teams",
  gps: "GPS",
  agent: "Agent",
  /** Interim value, approved for build (DESIGN-DIRECTION §2); replaced by real ages later. */
  simulatedValue: "Simulated",
  separator: " · ",
  groupLabel: "Adapter freshness",
  /** Says out loud that no time on this screen is real, so the header never over-claims. */
  interimNote: "Times are simulated until the live board is connected.",
} as const;

/**
 * Ages, humanized (COPY-GUIDE §1 "durations as '6 min'", §3 "'2 min ago'"). Raw seconds never
 * reach the screen above a minute; `humanizeAge` in src/ui/age.ts picks the template.
 */
export const age = {
  seconds: "{n} s",
  minutes: "{n} min",
  hours: "{h} h",
  hoursMinutes: "{h} h {m} min",
} as const;

/** COPY-GUIDE §5: SSE down >15 s. "SSE" is jargon and never reaches the screen. */
export const liveUpdates = {
  downTitle: "Live updates paused",
  downBody: "Live updates paused. Reconnecting… Board may be up to 40 s old.",
} as const;

/** COPY-GUIDE §6.1 / DESIGN-DIRECTION §7.1. Screen reader: "Source: {label}". */
export const sourceMode = {
  SIMULATED: "Simulated",
  REPLAY: "Replay",
  MANUAL: "Manual entry",
  SANDBOX: "Sandbox",
  LIVE: "Live",
} as const;

export const screenReader = {
  /** §9: chips read "State: Needs action". */
  state: "State: {label}",
  /** §7.1 */
  source: "Source: {label}",
  freshness: "{adapter}: {value}",
} as const;

/**
 * SURF-01 Board (Today). There is no data layer yet, so `empty` is not rendered anywhere
 * today — the Today route says it is not built (see `unbuilt`) rather than claim an empty day.
 */
export const board = {
  heading: "Today",
  empty: "No rides scheduled for {date}. Change the date or reset the demo.",
  dateLabel: "Service date",
} as const;

/**
 * Scenario clock in the header (§2). The demo-controls dock (§6.1) owns the clock; until it
 * is wired the readout says the demo has not started and Start says honestly why it is inert.
 */
export const scenarioClock = {
  label: "Scenario clock",
  notStarted: "Demo not started",
  start: "Start",
  /** Shown on hover and on focus; the button stays focusable so this can be read (§9). */
  startUnavailable: "Demo controls aren't connected yet.",
} as const;

/**
 * Surfaces that exist in the nav but whose data and interactions are not built yet. Each one
 * says so in its heading and then says, in one plain sentence, what it will do. No ticket
 * codes: a build-step name means nothing to a coordinator (COPY-GUIDE §1).
 */
export const unbuilt = {
  /** `{page}` is the nav label, so the heading reads "Health & ROI isn't built yet". */
  heading: "{page} isn't built yet",
  tag: "Not built yet",
  today: "The live board will show every ride, where each van is, and what needs attention.",
  exceptions:
    "This page will list what needs action, who is handling it, and when it is due.",
  setup: "This page will hold the vans, their seat layouts, and the people allowed to receive a child.",
  health:
    "This page will show whether each part of the system is working, next to the time the demo says it saves.",
} as const;

/** Sign-in. §9: visible labels, errors in text next to the field with aria-describedby. */
export const login = {
  heading: "Staff sign in",
  intro: "Demo accounts only.",
  emailLabel: "Email",
  passwordLabel: "Password",
  submit: "Sign in",
  error: "Email or password is incorrect.",
  errorSummary: "We could not sign you in.",
} as const;

/**
 * The map preview — a developer and design-review surface, like `whoami`: Vera and Veri walk
 * the DESIGN-DIRECTION §10 map checklist here before the live board exists. Its copy is
 * precise about what is and is not simulated rather than coordinator-friendly, and it still
 * lives in this file so the §1 voice rules apply to it too.
 */
export const mapPreview = {
  clock: "Scenario clock {time} ET",
  pause: "Pause",
  play: "Play",
  restart: "Restart",
  /** Clock speed buttons (§6.2): ×1 / ×10 / ×60. */
  speed: "×{factor}",
  motionReduced: "Reduced motion: markers step, no tween",
  motionTweened: "Tweened along route geometry",
  mapLabel: "Fleet map: simulated vehicles near the PPEC center",
  centerLabel: "PPEC center",
  decisionsHeading: "Notification decisions",
  /**
   * Says plainly that this step only *decides*. `{suppressed}` is `suppression` /
   * `suppressionPlural`, so the sentence carries no bare count without its noun.
   */
  decisionsIntro:
    "Decisions only — this step computes what would be sent, and why. Nothing is queued, nothing is sent, nothing is written to a database. {suppressed} so far this run (below threshold, not persisted, cooldown, stale GPS, or a stop already passed).",
  suppression: "{count} suppression",
  suppressionPlural: "{count} suppressions",
  decisionsEmpty: "No notification decision yet.",
  decisionRow: "{time} ET · {vehicle} · {family} · {shift} · new pickup window {window}",
  faultsHeading: "Injected faults",
  faultRow: "{vehicle} · {route} · {fault} ({provenance})",
  /** A device with no active binding has no position to show, so it is absent, not faint. */
  unbound:
    "{vehicle}'s device has no active binding: {unbound} points ingested and stored as unbound, {accepted} displayable. It has no marker, no row and no ETA.",
} as const;

/** Developer surface: confirms the signed-in identity against the database. */
export const whoami = {
  heading: "Signed in",
  /** Internal role enum names are allowed on developer surfaces only (COPY-GUIDE §2). */
  membership: "{role} at site {siteId}",
} as const;

/**
 * SURF-04 Ramp iPad (COPY-GUIDE §5 "SURF-04", §3 formats, DESIGN-DIRECTION §4.4).
 *
 * Every word the ramp check renders, including the strings the pure helpers in
 * src/app/ramp-preview/capability.ts build up — a verdict is computed there, but the sentence
 * that says it belongs here. Voice rules from §1 apply: plain, honest about certainty, a need
 * is never a diagnosis.
 */
export const rampPreview = {
  heading: "Ramp check",
  /** `{date}` is the site-timezone service date, "Tue, Oct 14" (§3). */
  subtitle: "{date} · afternoon rides",
  /** Says plainly that this surface records nothing, so nobody waits for a send that never happens. */
  localOnly:
    "Nothing on this page is sent anywhere. Answers stay in this browser so the vehicle check can be walked through.",

  arrivalsHeading: "Which vehicle is at the ramp?",
  /** §5: the vehicle tile reads "V1 · Provider P1 · arriving 8:52 · 3 riders", over two lines. */
  vehicleTile: "{vehicle} · {provider}",
  vehicleTileDetail: "arriving {time} · {riders} riders",

  checklistHeading: "What can {vehicle} carry today?",
  checklistIntro:
    "Unknown until arrival is normal. Anything left on “Not sure” keeps the run unchecked.",
  layoutLegend: "How is the vehicle set up?",
  liftRow: "Lift works?",
  latchRow: "Car-seat anchors (LATCH)",
  /** §5: every checklist row answers Yes / No / Not sure. "Not sure" is never read as a yes. */
  answer: { YES: "Yes", NO: "No", UNSURE: "Not sure" },
  positionAnswer: { FREE: "Free", OUT: "Out of service", UNSURE: "Not sure" },
  wcFree: "Wheelchair places free: {available} of {needed} needed",
  ambFree: "Walking seats free: {available} of {needed} needed",
  tetherFree: "Anchored seats free: {available} of {needed} needed",
  loseWifi: "Simulate losing Wi-Fi",
  wifiBack: "Wi-Fi is back",
  /** §5 offline pill, verbatim: "Offline · 3 saved on this iPad. They'll send when Wi-Fi is back." */
  offlinePill: "Offline · {count} saved on this iPad. They'll send when Wi-Fi is back.",

  slotsHeading: "Who sits where",
  wcPosition: "Wheelchair position {n}",
  ambPosition: "Walking seat {n}",
  wcPositionDetail: "{securement} · fits {length} × {width} cm",
  ambPositionDetail: "has an anchor",
  free: "Free",
  assign: "Assign",
  change: "Change",
  close: "Close",
  clearSeat: "Clear seat",
  noEligibleRider: "No rider on this run fits this place.",

  ridersHeading: "Riders",
  boardedReported: "Boarded (reported)",
  boardedVerified: "Boarded, verified · {time}",
  notOnVehicleChip: "Not on vehicle · {time}",
  leftEarlyChip: "Left early · {by} · {time}",
  /** §4.4: queued while offline, then stamped once it syncs. */
  recordedLate: "Recorded late",
  /** §5 SURF-02, reused here: a transport need is never a diagnosis. */
  needsCaption: "Derived from intake, not a diagnosis.",
  confirmBoarding: "Confirm boarding & securement",
  confirmAgain: "Tap again to confirm",
  notOnVehicle: "Not on vehicle",
  leftEarly: "Left early",
  whoPickedUp: "Who picked up?",
  whoPickedUpFor: "Who picked up {child}?",
  /** Roles only — no free-text names in the demo (§5 SURF-04). */
  pickupRoles: ["Parent or guardian", "Approved adult on the pickup list", "PPEC staff"],
  blockedPending: "Finish the vehicle check first. Every row needs Yes or No.",
  blockedInfeasible: "The run doesn’t fit yet. A coordinator decides before anyone boards.",

  queueHeading: "Saved on this iPad",
  queueRow: "{label} · {time}",
  queueLabel: "{action} · {child}",
  queueWaiting: "Waiting for Wi-Fi",
  queueSaved: "Saved here only",
  boardingConfirmed: "Boarding confirmed",
  /** §5: "Boarding confirmed for Leo B." with a 3 s Undo. */
  undo: "Undo",
  /** Closed with `sentence()`, since "{child}" already ends in the last initial's period. */
  snackBoarded: "Boarding confirmed for {child}",
  snackNotOnVehicle: "{child} marked not on vehicle",
  snackLeftEarly: "{child} marked left early",

  optionsHeading: "What a coordinator can choose",
  optionRow: "{label} — {detail}",
  needsApproval: "Needs a coordinator’s approval",
  optionsNote:
    "Reported by provider, not checked at the ramp, unless that vehicle was checked here too. Ramp staff don’t choose; the coordinator does.",

  /* ── the feasibility banner (§5 SURF-04) ── */
  /** §5: "Fits: 1 wheelchair, 1 walking seat." */
  fits: "Fits: {parts}.",
  fitsNobody: "Fits: nobody is riding this run.",
  checkedAs: "Checked as {layout}.",
  notChecked: "Not checked yet.",
  notCheckedDetail: "Answer every row to see whether the run fits.",
  vehicleOut: "This vehicle is out of service today.",
  /** §5: "Doesn't fit: needs 2 wheelchair positions, has 1. Coordinator alerted." */
  doesntFit: "Doesn't fit: {phrase}. Coordinator alerted.",
  foundAtStop: "Found at stop {k}.",
  withAnchors: "{parts} ({count} with an anchor)",
  deficitCount: "needs {needed}, has {available}",
  deficitFallback: "the run does not fit this vehicle",
  deficitSecurement: "the securement in this vehicle does not match a rider's chair",
  deficitFootprint: "a rider's chair is larger than the position allows",
  deficitLift: "the lift is not working and a rider boards by lift",

  /* ── rider need chips (§1: needs, never a diagnosis) ── */
  usesWheelchair: "Uses a wheelchair · {securement}",
  chairSize: "Chair {length} × {width} cm",
  needsAnchoredSeat: "Needs an anchored seat",
  escortRides: "Attendant rides along",

  /** Who the observation is attributed to when ramp staff answer the checklist themselves. */
  observedBy: "Ramp staff",
} as const;

/** Securement hardware in plain words, keyed by the ops.securement enum. */
export const securement = {
  L_TRACK: "L-track",
  SLIDE_N_CLICK: "slide-and-click",
  FOUR_POINT_STRAP: "four-point straps",
  OTHER: "other securement",
} as const;

/**
 * Singular / plural nouns the ramp banner counts. Kept as pairs rather than an "+s" rule so a
 * translator, or a noun that does not pluralise with an s, has somewhere to put the right word.
 */
export const countable = {
  wheelchair: { one: "wheelchair", many: "wheelchairs" },
  walkingSeat: { one: "walking seat", many: "walking seats" },
  wcPosition: { one: "wheelchair position", many: "wheelchair positions" },
  anchoredSeat: { one: "anchored seat", many: "anchored seats" },
} as const;

/** "1 wheelchair" / "2 wheelchairs" — a count never reaches the screen without its noun. */
export function pluralize(count: number, noun: { one: string; many: string }): string {
  return `${count} ${count === 1 ? noun.one : noun.many}`;
}
