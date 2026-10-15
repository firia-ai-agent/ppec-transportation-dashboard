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
  /**
   * The same ages in full words, for the ear only (§9). A screen reader reads "12 s" as
   * "twelve ess" and "4 min" as "four min", so the eye keeps the short form and the
   * screen-reader text says "12 seconds". Singular at exactly one, never "1 minutes".
   */
  spoken: {
    second: "{n} second",
    seconds: "{n} seconds",
    minute: "{n} minute",
    minutes: "{n} minutes",
    hour: "{h} hour",
    hours: "{h} hours",
    /** Joins the two halves of "1 hour 5 minutes". */
    separator: " ",
  },
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
  heading: "Map preview",
  /** <title> for the route, so the tab says which preview is open. */
  documentTitle: "Map preview · PPEC transportation dashboard",
  /**
   * What the surface is, in two sentences a reviewer reads once. It used to carry the build's
   * own surface code and a paragraph of fixture provenance; neither means anything to the
   * people who stand in front of this screen, so both are gone (COPY-GUIDE §1–§2).
   */
  intro: "Simulated vans on demo routes. Nothing here is live.",
  /** Said on the page itself: a preview surface is still behind staff sign-in. */
  signedInOnly: "Staff sign-in only. The data below is simulated, and the roles still apply.",
  clock: "Scenario clock {time} ET",
  pause: "Pause",
  play: "Play",
  restart: "Restart",
  /** Clock speed buttons (§6.2): ×1 / ×10 / ×60. */
  speed: "×{factor}",
  motionReduced: "Reduced motion: markers step, no tween",
  /**
   * What the markers are doing when motion is not reduced. It used to say "Tweened along route
   * geometry" — the implementation, in two words nobody outside this repo uses. The screen says
   * what a reviewer sees instead (COPY-GUIDE §1: plain words, no jargon).
   */
  motionTweened: "Vans follow their routes.",
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
  /**
   * A fault row names the van, the run in words and what was injected. The run's fixture id
   * ("route1", "route1-unbound") and the ticket it was written for never reach the screen —
   * a reviewer standing at the board reads a place name, not a file name.
   */
  faultRow: "{vehicle} · {route} · {fault}",
  /** A demo run, named by where it starts: "Okeeheelee Park run". */
  routeName: "{stop} run",
  /** Where the ramp iPad preview is, said from the map preview so it can be found at all. */
  openRampCheck: "Open the ramp check",
  /** A device with no active binding has no position to show, so it is absent, not faint. */
  unbound:
    "{vehicle}'s device has no active binding: {unbound} points ingested and stored as unbound, {accepted} displayable. It has no marker, no row and no ETA.",
} as const;

/**
 * Demo accounts offered under the sign-in form (founder decision, ledger rows 57 and 59).
 * Shown only where the demo flags are on and the data is synthetic, which is why the words can
 * be this plain: there is no real account to confuse these with. Each line says what that
 * person sees, not what the role is called in the database.
 *
 * `use` is what the eye reads on every card; `useRole` is the same button's accessible name,
 * which keeps the visible words and adds the role, so three identical buttons are three
 * distinct things to a screen reader. `filled` is announced in a live region after a fill.
 *
 * All three accounts share one password (ledger row 59), so each card still carries its own
 * email and that password — a card is a complete set of credentials, readable on its own —
 * and `shared` says once, above them, that the three passwords are the same password. The
 * value itself is config, not copy: `DEMO_SHARED_PASSWORD` in src/auth/demo-accounts.ts.
 */
export const demoLogins = {
  divider: "Or use a demo account",
  shared: "All three accounts use the same password.",
  use: "Use this account",
  useRole: "Use this account, {role}",
  filled: "{role} account filled",
  /** The field names the form above already uses, so the card labels match it. */
  emailLabel: login.emailLabel,
  passwordLabel: login.passwordLabel,
  roles: {
    DIRECTOR: {
      title: "Director",
      description: "Sees the whole site, the demo controls, and the health and savings view.",
    },
    COORDINATOR: {
      title: "Coordinator",
      description: "Runs the day: the board, what needs action, and approvals.",
    },
    FRONT_DESK: {
      title: "Front desk",
      description: "Handles arrivals and handoffs at the door.",
    },
  },
} as const;

/**
 * A URL that matches no page. One line, no apology and no blame (§1), and exactly one way
 * back, so there is nothing to choose between. The two labels are the words their destinations
 * already use — the nav item and the sign-in button — so a wording change there carries here.
 */
export const notFound = {
  heading: "This page doesn't exist.",
  today: nav.today,
  signIn: login.submit,
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
  localOnly: "Nothing here is sent. Answers stay on this iPad.",

  arrivalsHeading: "Which vehicle is at the ramp?",
  /** §5: the vehicle tile reads "V1 · Provider P1 · arriving 8:52 · 3 riders", over two lines. */
  vehicleTile: "{vehicle} · {provider}",
  vehicleTileDetail: "arriving {time} · {riders} riders",

  checklistHeading: "What can {vehicle} carry today?",
  checklistIntro:
    "Unknown until arrival is normal. Anything left on “Not sure” keeps the run unchecked.",
  layoutLegend: "How is the vehicle set up?",
  /**
   * A seat layout in words. The fixtures carry the trade's shorthand ("1WC/3A"), which is
   * fine on a manifest and wrong on a 56 px button a ramp attendant taps in the rain, so the
   * button says what the shorthand means. `layoutName` in src/app/ramp-preview/capability.ts
   * reads the two counts out of the code; these are the words it puts round them.
   */
  layout: {
    /** "No wheelchairs · 6 seats" — zero is said, never printed as "0 wheelchairs". */
    noWheelchairs: "No wheelchairs",
    separator: " · ",
  },
  /** Announced on any button that is the current choice, after its own label (§9). */
  selected: "selected",
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
  /**
   * The banner is pinned to the bottom of the iPad, so it is over the checklist for as long as
   * the page is scrolled. Collapsed it is one line — the verdict, which is the part that has to
   * be true at a glance — and the reason and the coordinator's options are one tap away.
   */
  showDetails: "Show details",
  hideDetails: "Hide details",
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
  /** The plain seat count on a layout button: "6 seats", "1 seat". */
  seat: { one: "seat", many: "seats" },
} as const;

/** "1 wheelchair" / "2 wheelchairs" — a count never reaches the screen without its noun. */
export function pluralize(count: number, noun: { one: string; many: string }): string {
  return `${count} ${count === 1 ? noun.one : noun.many}`;
}

/**
 * A seat layout in words: "1 wheelchair · 3 seats" for the fixtures' `1WC/3A`.
 *
 * The shorthand is how a provider writes a configuration down. It is fine on a manifest and
 * wrong on a 56 px button a ramp attendant taps in the rain, so every screen that shows a
 * layout — the ramp buttons, the "Checked as …" banner, the coordinator's alternate-vehicle
 * option — says what the shorthand means instead. Zero wheelchairs is *said* rather than
 * counted, because "0 wheelchairs" reads like a fault. A code this does not recognise comes
 * back unchanged, so a new fixture shows its own shorthand rather than an empty button.
 */
export function layoutName(code: string): string {
  const match = /^(\d+)WC\/(\d+)A$/.exec(code.trim());
  if (!match) return code;
  const chairs =
    Number(match[1]) === 0
      ? rampPreview.layout.noWheelchairs
      : pluralize(Number(match[1]), countable.wheelchair);
  return `${chairs}${rampPreview.layout.separator}${pluralize(Number(match[2]), countable.seat)}`;
}

/**
 * The fleet map pane (DESIGN-DIRECTION §5 / §5.1, PRD SURF-01). Words only: the layer
 * paints and the camera rules live in src/components/map/style.ts.
 *
 * §9 is the reason this list is longer than the map looks: the pane is never the only way
 * to read the fleet, so every marker has a row in the list beside it, and every row says
 * its freshness in words next to the tone colour.
 */
export const fleetMap = {
  /** Accessible name for the map region when the caller supplies none. */
  label: "Fleet map",
  fitAll: "Fit all vehicles",
  retry: "Retry",
  vehiclesHeading: "Vehicles",
  /** "V1 · Convertible van" — the id, then the vehicle in plain words. */
  vehicleRow: "{id} · {description}",
  /** "Provider P1 · In transit" */
  vehicleMeta: "{owner} · {state}",
  gps: "GPS: {age}",
  source: "Source: {label}",
  /** §5.1: a stall is words and a clock, never a colour. */
  stopped: "Stopped {minutes} min",
  /** LOC-03: the 600 s band, said out loud rather than shown only in red. */
  locationLost: "Location lost · dispatcher pinged",
  /** A stop the vehicle reached. Never "Handed off": a geofence cannot complete a handoff. */
  arrived: "Arrived (vehicle)",
  passed: "Passed",
  windowPending: "Window pending",
  /** LOC-03: the last published window, with the pause spelled out. */
  windowPaused: "{window} · ETA texts paused",
  /** The style request was abandoned (navigation, unmount): nothing more to say. */
  tilesFailed: "Map tiles did not load.",
  /** The style request failed: say what still works, so nobody assumes the board is down. */
  tilesFailedDetail: "Map tiles did not load. The board below is unaffected.",
  /**
   * "Okeeheelee Park · F4" — the stop, then the family it belongs to. The `title` tooltip on a
   * vehicle card's stop row, and nothing else: a family code is a build-internal label, so the
   * card's visible words are the place name alone (COPY-GUIDE §1–§2, src/ui/no-codes.test.ts).
   */
  stopFamily: "{stop} · {family}",
} as const;

/**
 * Why a geofence arrival is not a handoff (PRD SURF-01 l.1058). Surfaced next to an
 * arrival so the demo cannot be misread: the vehicle got there, a person still has to receive
 * the child. src/domain/location/geofence.ts re-exports this as `ARRIVAL_IS_NOT_HANDOFF`.
 */
export const arrival = {
  notHandoff: "Arrived (vehicle). Handoff needs a custody event naming the receiving adult.",
} as const;

/**
 * ETA deltas (COPY-GUIDE l.36). U+2212 for the minus, so "−3 min" lines up with the digits
 * instead of using a hyphen. `unknown` is what an unusable delta says: a missing or
 * non-finite shift is not "On time", and it is never printed as "−NaN min".
 */
export const etaText = {
  ahead: "+{n} min",
  behind: "−{n} min",
  onTime: "On time",
  unknown: "Not known yet",
} as const;

/**
 * The capacity solver's words (PRD §7 l.784-800, §9 l.880). A verdict is computed in
 * src/domain/solver/feasible.ts; the sentence that says it belongs here, so the §1 voice
 * rules (plain, honest about certainty, a need is never a diagnosis) apply to it.
 */
export const solver = {
  /** Why the answer is unknown rather than infeasible. Never read as a yes. */
  pending: {
    unobserved: "What this vehicle can carry today is unknown until arrival.",
    substituted:
      "A different vehicle is coming. What it can carry is unknown until the provider reports.",
    latchUnknown: "Car-seat anchors (LATCH) not reported yet.",
    liftUnknown: "Lift not reported yet, and a wheelchair rider needs it.",
    unsurePositions: "Some positions were answered “Not sure”.",
    unsureCapability: "Part of this vehicle's capability was answered “Not sure”.",
  },
  /** Capability states that put the vehicle out of today's reach entirely. */
  unusable: {
    REJECTED: "Staff rejected this vehicle's report for today.",
    UNAVAILABLE: rampPreview.vehicleOut,
    /** Already checked and already found not to fit: re-solving it would say the same thing. */
    VERIFIED_INFEASIBLE: "Staff checked this vehicle and the run does not fit it.",
  },
  /** Stands in for the rider names when the solver cannot name anyone (§3: no bare counts). */
  unnamedRiders: "the riders who have not boarded",
  /**
   * The PRD §7 l.799 option set. Button-length labels, no ticket codes (§2), and one
   * sentence of detail a coordinator can act on. Every one of them needs a human.
   */
  options: {
    SPLIT_RUN: {
      label: "Split the run",
      detail:
        "Run {who} separately on {vehicle}. Everyone already on the vehicle stays where they are.",
    },
    ALTERNATE_VEHICLE: {
      label: "Move to {vehicle}",
      detail: "{description} ({provider}) fits {who} as {layout}.",
    },
    ALTERNATE_PROVIDER: {
      label: "Move to {vehicle}",
      detail: "{description} ({provider}) fits {who} as {layout}.",
    },
    FAMILY_TRANSPORT: {
      label: "Ask the family to drive",
      detail:
        "Ask the family of {who} to drive today. The family is told only after staff choose.",
    },
    DELAY: {
      label: "Delay the run",
      detail: "Hold the run until a vehicle that fits is free. {who} waits at the center.",
    },
    CANCEL: {
      label: "Cancel the ride",
      detail: "Cancel today's ride for {who}. Attendance and therapy sessions are updated.",
    },
  },
  /** The delay sentence with nobody to name, so it never reads "{who} waits at the center". */
  delayAnyone: "Hold the run until a vehicle that fits is free. Riders wait at the center.",
} as const;

/**
 * The demo-reset endpoint's answers (ADR-014, DECISION-LEDGER row 17). An operator reads
 * these, so they say what refused and why in plain words, and never name a flag, a ticket or
 * a connection detail. src/modules/demo/reset.ts chooses between them.
 */
export const demoReset = {
  previewRefusal:
    "Refusing: preview deployments share the one production database, so the demo reset is disabled here.",
  notEnabled: "Demo controls are not enabled here.",
  notSynthetic: "Refusing: this deployment is not marked as synthetic data.",
  enabled: "Demo controls are enabled.",
  signIn: "Sign in to continue.",
  directorOnly: "Only a director can reset the demo.",
  nameTheSite: "Name the site to reset.",
} as const;

/**
 * Outbound family SMS (COPY-GUIDE §1 voice, §5 "Outbound family SMS", §6 "[DEMO]" suffix;
 * 10DLC HELP/STOP reply requirement, PRD §17 D-04). A family reads these, so they live here
 * with the rest of the copy; `src/modules/messaging/templates.ts` owns the rendering — which
 * var fills which placeholder, and which of these sentences a reason code becomes.
 *
 * `reasonCode` is why the code tables are here at all. Since Veri #12 an outbound reason is a
 * fixed code rather than staff free text (`outbox.LEG_CANCEL_REASON_CODES`,
 * `CLOSURE_REASON_CODES`), and COPY-GUIDE §2 keeps enum names off family surfaces, so the
 * code has to become words somewhere — and this is where words are kept. WEATHER is in both
 * tables; the sentences are per template, so each one can read naturally in its own body.
 *
 * No body names a child. The Veri #12 rule (outbox.ts) is that an outbound var carries only a
 * fixed code or a constrained format, and a child's given name is neither: it identifies the
 * child to anyone holding the phone, and no body needs it — a guardian reads "your child", a
 * therapist reads "a child" and knows the session. So there is no `childFirstName` placeholder
 * in this table, the outbox allows no such var, and the tests check both.
 *
 * The vehicle is a "van", the word a family uses for what pulls up (COPY-GUIDE §1 plain voice),
 * not the service word "ride".
 */
export const outboundSms = {
  /** COPY-GUIDE §6: a simulated message says so, in every body, with no exception. */
  demoTag: "[DEMO]",
  optOut: "Reply HELP for help, STOP to opt out.",
  /** The center's number as the copy guide writes it (COPY-GUIDE §5 dispatcher link). */
  centerPhone: "(561) 555-0100",
  /** The fixed answer to an inbound HELP: same words every time, no child name and no van detail. */
  helpReply:
    "PPEC: This number sends van updates for your child. Call us at {centerPhone} if you need help. Reply STOP to opt out. {demoTag}",
  /**
   * The pickup places a family knows by name (MOCKS §1: public landmarks, never a home), keyed by the
   * short stop token the outbox carries. The token is a developer-facing shape and a family must never
   * read one, so this fixed table is the only way a stop becomes words: messaging/templates.ts resolves
   * `stopLabel` through it, and a token with no entry falls back to `unknownStop`. The table is code-owned
   * — nothing a coordinator types reaches it, which is what keeps the outbox's no-free-text rule intact.
   */
  stops: {
    "GA-LIBRARY": "Greenacres Branch Library",
    "OKEE-PARK": "Okeeheelee Park",
    "GA-CITYHALL": "Greenacres City Hall",
    "PRINCE-PARK": "John Prince Park",
    "PBSC-LW": "Palm Beach State College, Lake Worth",
    "LANTANA-LIB": "Lantana Public Library",
    "BOYNTON-MALL": "Boynton Beach Mall",
    "WELLINGTON": "Mall at Wellington Green",
    "PB-ZOO": "Palm Beach Zoo",
    /** The center names itself, never its street address (§5 "never … addresses"). */
    "CENTER": "the PPEC center",
  },
  /** A stop token with no copy. Vague on purpose: better than a code, and it names no wrong place. */
  unknownStop: "your usual stop",
  /** A window, §3 "windows \"8:12–8:22 AM\"". The en dash is the guide's, not a hyphen. */
  etaWindow: "{start}–{end}",
  /** One time with no window end: still an estimate, so it does not promise the minute. */
  etaApprox: "around {time}",
  bodies: {
    "pickup.eta":
      "PPEC: Your child's van is on the way to {stopLabel}. Pickup {eta}. {optOut} {demoTag}",
    "dropoff.eta":
      "PPEC: Your child's van home is on the way to {stopLabel}. Arrival {eta}. {optOut} {demoTag}",
    "leg.canceled":
      "PPEC: Got it. Your child's van on {legDate} is canceled. {reasonCode} {optOut} {demoTag}",
    "leg.changed":
      "PPEC: Your child's van on {legDate} changed. New pickup {eta} at {stopLabel}. {optOut} {demoTag}",
    "therapist.absence_alert":
      "PPEC: A child is not coming in today. The {sessionStart} session is affected. {optOut} {demoTag}",
    "therapist.late_alert":
      "PPEC: A child is running late for the {sessionStart} session. Now expected {eta}. {optOut} {demoTag}",
    "child.not_received":
      "PPEC: We could not hand off your child at {stopLabel} at {eta}. Please call us at {centerPhone}. {demoTag}",
    "center.closure": "PPEC: The center is closed on {date}. {reasonCode} {optOut} {demoTag}",
    /**
     * Fixed copy, no vars (Veri #12): a staff-typed notice could carry a child's name, so the
     * only generic message we can send is the one that asks the family to call.
     */
    "generic.notice":
      "PPEC: There is an update about your child's transportation. Please call us at {centerPhone}. {optOut} {demoTag}",
  },
  /** What a `reasonCode` says to a family, per template. */
  reasons: {
    "leg.canceled": {
      VEHICLE_UNAVAILABLE: "The vehicle is not available.",
      WEATHER: "This is because of the weather.",
      CENTER_CLOSED: "The center is closed.",
      FAMILY_REQUEST: "This is at your request.",
      SCHEDULE_CHANGE: "The schedule changed.",
    },
    "center.closure": {
      WEATHER: "This is because of the weather.",
      FACILITY: "This is a building issue.",
      HOLIDAY: "This is for a holiday.",
      EMERGENCY: "This is an emergency closure.",
    },
  },
} as const;

/**
 * The staff task a revoked consent opens (MSG-04, PRD §10). A coordinator reads these on the
 * Exceptions board, so the summary is a label and the next step is one thing to do; the
 * predicate is the condition that closes the task, which staff also read.
 * `src/modules/messaging/consent.ts` chooses between them.
 */
export const consentFollowUp = {
  STOP: {
    summary: "Family opted out of text messages",
    nextStep:
      "Record another authorized contact for van updates, or agree a phone call with the family.",
    predicate: "another authorized contact recorded for this family, or a call logged",
  },
  NL_OPT_OUT: {
    summary: "Family asked us in their own words to stop texting",
    nextStep: "Call the family to confirm what they want and record it.",
    predicate: "call logged confirming the family's choice",
  },
} as const;
