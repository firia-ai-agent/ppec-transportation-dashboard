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
