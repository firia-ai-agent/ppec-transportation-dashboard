/**
 * WHO CAN SEE WHAT — the one access table.
 *
 * Every page, every layout, every API route and every server action in this app has exactly one
 * row here, and the guards read their answers from it: src/auth/page-guard.ts for pages and
 * layouts, src/auth/api-guard.ts for routes, src/modules/demo/reset.ts for the one write that
 * takes a site id. Nothing decides access anywhere else, and `access.test.ts` walks the
 * filesystem and fails if a surface exists without a row — so a new route cannot ship ungated
 * by being forgotten here.
 *
 * SOURCES, per row, in `why`. The ones that decide most of the table:
 *  - ADR-004: roles are DIRECTOR | COORDINATOR | FRONT_DESK, re-read from `ops.site_membership`
 *    per request; every handler goes through a site + role check; `proxy.ts` is not the
 *    authorization layer.
 *  - ARCHITECTURE §1: the web console is the "Coordinator / Director" surface and the ramp iPad
 *    is the "Front desk / ramp" surface — which is why the console pages are not open to the
 *    front desk and the ramp check is open to everyone.
 *  - PRD §14 (l.1055–1064): which surface each nav destination is.
 *  - PRD §6.2: who writes what (approvals: director; attendance plan and legs: coordinators;
 *    actual attendance and custody: front desk / ramp).
 *  - BUILD-PLAN §4: the expected ID-swap answers — same site with a role that is not allowed is
 *    403, another site is 404.
 *  - ADR-014 / ARCHITECTURE §2: the demo endpoints answer only when `DEMO_MODE=1` and
 *    `APP_DATA_CLASS=SYNTHETIC` **and** the caller is DIRECTOR.
 *
 * Where the docs are silent the row defaults to DENY — the narrowest set that keeps the surface
 * usable at all — and carries an `openQuestion`, which PR-BODY.md lists for the founder.
 *
 * Pure module: no `next/*`, no Auth.js, no database, no `process.env`, and `StaffRole` arrives
 * as a type-only import, so the whole table is unit-testable and the client components that read
 * it for the nav do not pull bcrypt into the browser bundle.
 */
import type { StaffRole } from "@/auth/core";
import type { MapViewer } from "@/domain/access/map-view";
import { fill, login, liveMap, nav, noAccess, planRoutes, rampIpad, roleNames, whoami } from "@/ui/copy";

/** Most capable first. The order the `{who}` line and `mostCapable` read. */
export const ROLE_LADDER = ["DIRECTOR", "COORDINATOR", "FRONT_DESK"] as const;

/** Every staff role. A row that uses this is open to all staff, never to the public. */
export const ALL_STAFF: readonly StaffRole[] = ROLE_LADDER;

/** The console pages: ARCHITECTURE §1 gives the web console to the coordinator and director. */
const CONSOLE: readonly StaffRole[] = ["DIRECTOR", "COORDINATOR"];

/* ───────────────────────────── who is asking ───────────────────────────── */

/**
 * The caller of this request, as the guards see it. Three cases, because they get three
 * different answers:
 *  - `ANONYMOUS` — no session, or a session whose user is disabled or gone. Pages redirect to
 *    sign-in; APIs answer 401.
 *  - `NO_ROLE` — an active user who holds no membership at any site. Signed in, so sending them
 *    to sign-in would only bounce them; they get the no-access page and a 403.
 *  - `STAFF` — an active user with a role. `userId` is absent for the browser-test session,
 *    which is a role and no identity (src/domain/access/map-view.ts), so nothing that writes
 *    can accept it.
 */
export type Caller =
  | { kind: "ANONYMOUS" }
  | { kind: "NO_ROLE"; userId: string }
  | { kind: "STAFF"; role: StaffRole; userId?: string };

/** The most capable role a user holds, since one person can be a member of several sites. */
export function mostCapable(roles: readonly StaffRole[]): StaffRole | null {
  return ROLE_LADDER.find((role) => roles.includes(role)) ?? null;
}

/* ───────────────────────────── the row types ───────────────────────────── */

/**
 * A page or layout is open to a set of roles, to anyone signed in, or to anyone at all
 * (sign-in, the 404, the entry route). `signedIn` is the console *layout* only: the shell
 * checks that there is a session and each page inside it checks the role, so a refusal is
 * rendered by the page that was asked for and can say who that page is for.
 */
export type PageAccess = { roles: readonly StaffRole[] } | { signedIn: true } | { public: true };

export type PageRow = {
  kind: "page" | "layout";
  /** Repo-relative source file. `access.test.ts` matches these against the filesystem. */
  file: string;
  /**
   * The key this row is looked up by: the path a browser asks for, or `layout:<name>` for a
   * layout, which is not a destination of its own but is still a guard point.
   */
  path: string;
  access: PageAccess;
  /** The words this destination already uses, when it can be linked to. */
  label?: string;
  /**
   * True where the docs do not settle this row and the default above is DENY-shaped. The
   * reasoning, and the question itself, are in the comment on the row; `foundersQuestions()`
   * lists them so the PR description cannot quietly drop one.
   *
   * The reasoning is a comment rather than a field because no sentence may live outside
   * src/ui/copy.ts in this repo (copy.test.ts, "writes no sentence of its own"), and these are
   * citations between engineers, not words for a screen.
   */
  founderQuestion?: true;
};

/**
 * How a route proves it may run. Named, because "guarded" is not one thing here:
 *  - `session` — Auth.js session + role, re-read from the DB per request (ADR-004).
 *  - `cron-secret` — `Authorization: Bearer $CRON_SECRET`, fail-closed (src/lib/cron-auth.ts).
 *    A signed-in session grants nothing on these, by design.
 *  - `queue-callback` — invoked by the platform's queue with its own message headers; Vercel
 *    does not expose these routes to the public internet. A session grants nothing here either.
 *  - `signature-webhook` — reachable from the public internet (a provider posts to it and has no
 *    session to offer), but every request must carry an HMAC of its own raw body in `header`,
 *    keyed by the secret in `secretEnv`. So "public network-wise, behind a verified signature":
 *    unsigned, wrongly signed, signed over a different body, or no secret configured ⇒ 401, and
 *    the check runs before anything is parsed, read or written. A staff session grants nothing
 *    here — exactly as on `cron-secret` and `queue-callback` — because the caller is a machine
 *    and a browser that can reach the URL must not be able to forge an inbound message.
 *  - `auth-endpoint` — Auth.js's own sign-in/sign-out/session handlers, which must be reachable
 *    before anyone has a session.
 *  - `public` — deliberately open, with the reason in `why`.
 */
export type EndpointAuth =
  | { kind: "session"; roles: readonly StaffRole[]; siteScoped: boolean }
  | { kind: "cron-secret" }
  | { kind: "queue-callback" }
  /** The request header carrying the hex HMAC, and the environment variable holding the key. */
  | { kind: "signature-webhook"; header: string; secretEnv: string }
  | { kind: "auth-endpoint" }
  | { kind: "public" };

export type EndpointRow = {
  kind: "route" | "action";
  file: string;
  /** The request path, or `action:<name>` for a server action, which has no URL of its own. */
  path: string;
  methods: readonly ("GET" | "POST")[];
  auth: EndpointAuth;
  /** See {@link PageRow.founderQuestion}. */
  founderQuestion?: true;
};

/* ─────────────────────────────── the table ─────────────────────────────── */

/**
 * `/api/...` strings live here and nowhere else under src/app or src/ui: an internal endpoint
 * is not something a screen may print, and `no-internals.test.ts` holds that line by scanning
 * those two trees for the literal. The routes name their row through these constants.
 */
/**
 * Layout keys. A layout has no URL of its own, but it is a guard point and needs a row.
 *
 * Four of them mount the console shell: the `(app)` group, and one per route folder for the
 * three screens that are outside it (`/plan-routes`, `/live-map`, `/ramp-ipad`). Every one of
 * those four asks for a session and nothing more — the role belongs to the page inside, so the
 * refusal is rendered by the page that was asked for and can say who it is for.
 */
export const LAYOUT = {
  root: "layout:root",
  console: "layout:console",
  planRoutes: "layout:plan-routes",
  liveMap: "layout:live-map",
  rampIpad: "layout:ramp-ipad",
} as const;

export const API = {
  auth: "/api/auth/[...nextauth]",
  health: "/api/health",
  cronSweep: "/api/cron/sweep",
  probeDelay: "/api/probe/delay",
  demoReset: "/api/demo/reset",
  queueTimer: "/api/queues/timer",
  queueOutbox: "/api/queues/outbox",
  queueAgent: "/api/queues/agent",
  queueDelayProbe: "/api/queues/delay-probe",
  smsWebhook: "/api/webhooks/sms",
  simPhoneMessages: "/api/sim/phones/[number]/messages",
} as const;

export const PAGES: readonly PageRow[] = [
  /**
   * The document shell: fonts, tokens and the DEMO bar on every route, signed in or not (§7,
   * §7.1, NFR-09). It reads no data.
   */
  {
    kind: "layout",
    file: "src/app/layout.tsx",
    path: LAYOUT.root,
    access: { public: true },
  },
  /**
   * The entry route only redirects: signed out to sign-in, signed in to that role's own first
   * page. It renders nothing and reads no site data.
   */
  {
    kind: "page",
    file: "src/app/page.tsx",
    path: "/",
    access: { public: true },
  },
  /**
   * Sign-in itself (ADR-004). Must be reachable before anyone has a session.
   */
  {
    kind: "page",
    file: "src/app/login/page.tsx",
    path: "/login",
    access: { public: true },
    label: login.heading,
  },
  /**
   * A URL that matches no page. One line and one way out; it names no object and reads no site
   * data.
   */
  {
    kind: "page",
    file: "src/app/not-found.tsx",
    path: "/_not-found",
    access: { public: true },
  },
  /**
   * The signed-in console shell. Sign-in is checked here for every page inside it; which of
   * those pages a role may open is each page's own row, so the refusal is rendered by the page
   * that was asked for.
   */
  {
    kind: "layout",
    file: "src/app/(app)/layout.tsx",
    path: LAYOUT.console,
    access: { signedIn: true },
  },
  /**
   * The same shell, on the three screens that are routes of their own outside that group. They
   * rendered with no menu at all until 2026-10-17, which is how a founder walking production
   * reached Plan routes and found the browser's Back button was the only way out of it.
   *
   * Each is a session check and nothing more, exactly as the group's row is: the page inside
   * checks its own row — the two console roles for /plan-routes, every staff role for the other
   * two — so no role gains or loses a screen by these three rows existing. That is the point of
   * them being `signedIn`, and src/auth/guard-matrix.test.ts asks all four layouts directly.
   */
  {
    kind: "layout",
    file: "src/app/plan-routes/layout.tsx",
    path: LAYOUT.planRoutes,
    access: { signedIn: true },
  },
  {
    kind: "layout",
    file: "src/app/live-map/layout.tsx",
    path: LAYOUT.liveMap,
    access: { signedIn: true },
  },
  {
    kind: "layout",
    file: "src/app/ramp-ipad/layout.tsx",
    path: LAYOUT.rampIpad,
    access: { signedIn: true },
  },
  /**
   * SURF-01 board + SURF-02 drawer + SURF-03 inbox (PRD §14, l.1055). ARCHITECTURE §1 gives the
   * web console to the coordinator and director; the front desk's surface is the ramp iPad
   * (SURF-04). PRD §6.2: the attendance plan and the legs are written by coordinators.
   *
   * OPEN QUESTION for the founder: Should the front desk see the board read-only (they do see
   * arrivals at the door), or stay on the ramp check only?
   */
  {
    kind: "page",
    file: "src/app/(app)/today/page.tsx",
    path: "/today",
    access: { roles: CONSOLE },
    label: nav.today,
    founderQuestion: true,
  },
  /**
   * SURF-05 Exceptions & Approvals (PRD §14). PRD l.774 names a coordinator/director role for
   * the decision, and BUILD-PLAN §4 makes 'front desk → approval_request decide' an expected
   * 403.
   */
  {
    kind: "page",
    file: "src/app/(app)/exceptions/page.tsx",
    path: "/exceptions",
    access: { roles: CONSOLE },
    label: nav.exceptions,
  },
  /**
   * Children/needs, providers/vehicles/layouts, contacts, therapists (PRD §14). PRD §6.2:
   * approved operational needs are a director approval, the roster is the coordinator's.
   *
   * OPEN QUESTION for the founder: Setup will hold director-only actions (approving a need)
   * next to coordinator ones (the roster). Confirm the page stays open to both and the approval
   * action alone is director-only.
   */
  {
    kind: "page",
    file: "src/app/(app)/setup/page.tsx",
    path: "/setup",
    access: { roles: CONSOLE },
    label: nav.setup,
    founderQuestion: true,
  },
  /**
   * SURF-06 Health & SURF-07 ROI (PRD §14). PRD l.1200 puts the runbook in the on-duty
   * coordinator's hands, and SURF-06 is where the degraded instruction is read, so the
   * coordinator is in.
   *
   * OPEN QUESTION for the founder: The ROI half (SURF-07) is signed off by the director and the
   * founder (PRD §16). Should the savings numbers be director-only once that panel is built,
   * with the coordinator seeing adapter health only?
   */
  {
    kind: "page",
    file: "src/app/(app)/health/page.tsx",
    path: "/health",
    access: { roles: CONSOLE },
    label: nav.health,
    founderQuestion: true,
  },
  /**
   * A developer page that shows the signed-in person their own name and their own memberships,
   * and nothing about anyone else.
   *
   * OPEN QUESTION for the founder: Keep this developer page in the deployed app for all three
   * roles, or drop it once the console is real?
   */
  {
    kind: "page",
    file: "src/app/whoami/page.tsx",
    path: "/whoami",
    access: { roles: ALL_STAFF },
    label: whoami.heading,
    founderQuestion: true,
  },
  /**
   * The live map (DESIGN-DIRECTION §5). Open to all staff; what each role actually sees on it is
   * the per-key matrix in src/domain/access/map-view.ts (the front-desk iPad gets the vans and
   * no family labels or notification queue).
   */
  {
    kind: "page",
    file: "src/app/live-map/page.tsx",
    path: "/live-map",
    access: { roles: ALL_STAFF },
    label: liveMap.heading,
  },
  /**
   * Plan routes (B-09 VEH-01…05, B-13): the coordinator's planning surface — a lane per van, the
   * children in it, and the children no van fits.
   *
   * The two console roles and not the front desk, and the docs settle it rather than a default:
   * PRD §6.2 gives "attendance plan" and "legs" to coordinators, ARCHITECTURE §1 gives the web
   * console to the coordinator and the director, and the front desk's own surface is the ramp
   * iPad — where a van that has arrived is checked, which is a different job from deciding which
   * van a child rides in. Nothing on this page is director-only, so both console roles are in.
   */
  {
    kind: "page",
    file: "src/app/plan-routes/page.tsx",
    path: "/plan-routes",
    access: { roles: CONSOLE },
    label: planRoutes.heading,
  },
  /**
   * SURF-04, the ramp iPad: the front desk's own surface (PRD §6.2, ARCHITECTURE §1), and a
   * coordinator and a director both walk it.
   *
   * It was the front desk's home, and the open question on this row was whether that was right
   * until SURF-04 is real. Firia answered it on 2026-10-17 at 3:08 PM ET — "Front desk gets two
   * tabs, Live map (their home) and Ramp iPad" — so the question is closed and the flag is off
   * the row. This is still their second tab, and the surface the PRD names them after; the
   * screen is a walk-through of SURF-04 and records nothing.
   */
  {
    kind: "page",
    file: "src/app/ramp-ipad/page.tsx",
    path: "/ramp-ipad",
    access: { roles: ALL_STAFF },
    label: rampIpad.heading,
  },
  /* ── the three old addresses, kept as permanent redirects ── */
  /**
   * `/plan-preview`, `/map-preview` and `/ramp-preview` were the three screens' addresses until
   * Vera's review (2026-10-17) took "preview" out of every menu label and address. A URL that
   * has been read out loud in a demo, pasted into a pull request and bookmarked by the founder
   * does not get to stop answering, so each one is still a page: it redirects permanently (308)
   * to the screen's own address.
   *
   * Each redirect keeps the row its screen has, to the role — not `signedIn`, not public. A
   * redirect is a tiny oracle: an open `/ramp-preview` would tell a front-desk caller that
   * `/plan-routes` exists, and a public one would tell anyone with the URL that this app has a
   * planning surface before they have signed in. So the old address refuses exactly what the new
   * one refuses: signed out is sign-in, the wrong role is the no-access page and a 403 rendered
   * by the boundary beside the redirect, and only a caller who could open the destination is
   * ever sent to it. `access.test.ts` asserts the two rows carry the same roles, and
   * `guard-matrix.test.ts` asks the server.
   */
  {
    kind: "page",
    file: "src/app/plan-preview/page.tsx",
    path: "/plan-preview",
    access: { roles: CONSOLE },
    label: planRoutes.heading,
  },
  {
    kind: "page",
    file: "src/app/map-preview/page.tsx",
    path: "/map-preview",
    access: { roles: ALL_STAFF },
    label: liveMap.heading,
  },
  {
    kind: "page",
    file: "src/app/ramp-preview/page.tsx",
    path: "/ramp-preview",
    access: { roles: ALL_STAFF },
    label: rampIpad.heading,
  },
];

/**
 * The old address → the screen's own address, for the three redirect pages above. One table, so
 * a redirect cannot point somewhere the access table does not hold (`access.test.ts` checks
 * both ends of every pair, and that the two rows are open to the same roles).
 */
export const MOVED_PAGES: Readonly<Record<string, string>> = {
  "/plan-preview": "/plan-routes",
  "/map-preview": "/live-map",
  "/ramp-preview": "/ramp-ipad",
};

export const ENDPOINTS: readonly EndpointRow[] = [
  /**
   * Auth.js's own handlers (ADR-004): sign-in, sign-out and the session endpoint. Reachable
   * before a session exists, by definition; credentials are checked by the provider.
   */
  {
    kind: "route",
    file: "src/app/api/auth/[...nextauth]/route.ts",
    path: API.auth,
    methods: ["GET", "POST"],
    auth: { kind: "auth-endpoint" },
  },
  /**
   * The deployment probe (README): commit, branch, environment, data class and the non-secret
   * Neon endpoint id. No site data, no PHI, no secrets (src/lib/health.test.ts holds that), and
   * the platform must be able to read it without a session.
   *
   * OPEN QUESTION for the founder: Leave the deployment probe open, or put it behind the cron
   * secret? Open today means the deployed commit and the Neon endpoint id are readable by
   * anyone with the URL.
   */
  {
    kind: "route",
    file: "src/app/api/health/route.ts",
    path: API.health,
    methods: ["GET"],
    auth: { kind: "public" },
    founderQuestion: true,
  },
  /**
   * Vercel Cron every minute (vercel.json). `Authorization: Bearer $CRON_SECRET`, fail-closed
   * when the secret is unset (ARCHITECTURE §5). A staff session grants nothing here, and must
   * not: this claims jobs and sends the outbox.
   */
  {
    kind: "route",
    file: "src/app/api/cron/sweep/route.ts",
    path: API.cronSweep,
    methods: ["GET"],
    auth: { kind: "cron-secret" },
  },
  /**
   * The sub-second delay probe (ledger row 58), guarded exactly like the sweep: bearer cron
   * secret, fail-closed. Not a session surface.
   */
  {
    kind: "route",
    file: "src/app/api/probe/delay/route.ts",
    path: API.probeDelay,
    methods: ["GET"],
    auth: { kind: "cron-secret" },
  },
  /**
   * ADR-014 / ARCHITECTURE §2: the demo endpoints answer only with DEMO_MODE=1 and
   * APP_DATA_CLASS=SYNTHETIC and a DIRECTOR caller, and never from a preview deployment (ledger
   * #43). The site comes from the caller's own membership, so another site's id is a uniform
   * not-found (BUILD-PLAN §4).
   */
  {
    kind: "route",
    file: "src/app/api/demo/reset/route.ts",
    path: API.demoReset,
    methods: ["POST"],
    auth: { kind: "session", roles: ["DIRECTOR"], siteScoped: true },
  },
  /**
   * Queue trigger for topic ppec-timer (vercel.json). Invoked by the platform's queue with its
   * own message headers and not publicly invocable per the Vercel Queues docs; a staff session
   * grants nothing.
   */
  {
    kind: "route",
    file: "src/app/api/queues/timer/route.ts",
    path: API.queueTimer,
    methods: ["POST"],
    auth: { kind: "queue-callback" },
  },
  /**
   * Queue trigger for topic ppec-outbox (vercel.json). Same platform invocation path as the
   * timer; a staff session grants nothing.
   */
  {
    kind: "route",
    file: "src/app/api/queues/outbox/route.ts",
    path: API.queueOutbox,
    methods: ["POST"],
    auth: { kind: "queue-callback" },
  },
  /**
   * Queue trigger for topic ppec-agent (vercel.json): one message, one agent run (PRD §11.1 "each
   * run = job"). Same platform invocation path as the timer, and a staff session grants nothing —
   * which matters more here than on the other two, because the thing behind this route takes a
   * model turn and executes §11.2 tools. The tenant is not the caller's to assert either: the run
   * id and the site both arrive on the queue payload, and the per-run claim is fenced on the site
   * the payload names (F2/F3, `src/modules/agent/run/lease.ts`), so a forged or mis-copied message
   * is a no-op rather than a cross-tenant drive.
   */
  {
    kind: "route",
    file: "src/app/api/queues/agent/route.ts",
    path: API.queueAgent,
    methods: ["POST"],
    auth: { kind: "queue-callback" },
  },
  /**
   * Queue trigger for topic ppec-delay-probe (vercel.json). Logs one line per delivery, touches
   * no database; a staff session grants nothing.
   */
  {
    kind: "route",
    file: "src/app/api/queues/delay-probe/route.ts",
    path: API.queueDelayProbe,
    methods: ["POST"],
    auth: { kind: "queue-callback" },
  },
  /**
   * Inbound SMS (MSG-01, ADR-006, MOCKS §3). A provider posts here; there is no session to offer
   * and never will be, so the route is reachable from the public internet and every request must
   * carry an HMAC of its own raw body in `x-sim-signature` (`X-Twilio-Signature` when the live
   * adapter lands — only the verification line changes). Unsigned, wrongly signed, signed over a
   * different body, or `SIM_WEBHOOK_SECRET` unset ⇒ 401 with no side effect of any kind, and the
   * compare is constant-time (src/modules/messaging/inbound.ts).
   *
   * A staff session grants nothing here, like the cron and queue rows above, and this one matters
   * more than either: the handler writes a message row, a consent event, a suppression and a
   * staff task, so a browser that can reach the URL must not be able to forge a family's SMS.
   * The signature check is therefore the first statement in POST — ahead of the preview skip, the
   * form parse, the pepper, the database and the outbox.
   */
  {
    kind: "route",
    file: "src/app/api/webhooks/sms/route.ts",
    path: API.smsWebhook,
    methods: ["POST"],
    auth: { kind: "signature-webhook", header: "x-sim-signature", secretEnv: "SIM_WEBHOOK_SECRET" },
  },
  /**
   * The contents of one persona phone, for the sim panel (MOCKS §3, DESIGN-DIRECTION §6.3). A
   * staff session, the two console roles, and a membership at the site that phone belongs to.
   *
   * Why not the front desk, who holds every other read in this app: PRD §1.1 gives the
   * "Transport/attendance coordinator, director" the "Web console (desktop + iPad)" and gives
   * "Front desk / ramp staff" the "iPad ramp + check-in view" — the sim panel is a web-console
   * instrument, not a ramp one. PRD §6.2's data-ownership table lists Messages as written by
   * "adapters only" and puts the front desk down as the writer of "Actual attendance/custody"
   * alone, so a message thread is not part of their job. And a family's thread is PHI-adjacent:
   * §12 is minimum-necessary, so a role with no task that needs the thread does not get it.
   *
   * Site-scoped on the phone's *own* site, read from the data and never from the request
   * (DATA-MODEL §5): a phone at a site the caller is not a member of is the same 404 as a number
   * that belongs to nobody, so the answer cannot be used to find out which phones exist
   * (BUILD-PLAN §4). A member of that site holding the wrong role is a 403, because their site's
   * existence is not a secret from them.
   */
  {
    kind: "route",
    file: "src/app/api/sim/phones/[number]/messages/route.ts",
    path: API.simPhoneMessages,
    methods: ["GET"],
    auth: { kind: "session", roles: CONSOLE, siteScoped: true },
  },
  /**
   * The sign-in form's own action (ADR-004). It hands email and password to the credentials
   * provider and nothing else; it must run for a caller with no session.
   */
  {
    kind: "action",
    file: "src/app/login/page.tsx",
    path: "action:sign-in",
    methods: ["POST"],
    auth: { kind: "auth-endpoint" },
  },
  /**
   * Destroys the caller's own session and nothing else. Open on purpose: signing out must work
   * for anyone holding a session, including a user whose role was just removed.
   */
  {
    kind: "action",
    file: "src/ui/SignOutButton.tsx",
    path: "action:sign-out",
    methods: ["POST"],
    auth: { kind: "public" },
  },
];

/** Every row, pages and endpoints together. */
export const POLICY: ReadonlyArray<PageRow | EndpointRow> = [...PAGES, ...ENDPOINTS];

/**
 * Every row the docs do not settle. The PR description answers each one; the comment on the row
 * holds the reasoning and the question.
 */
export function foundersQuestions(): readonly string[] {
  return POLICY.filter((row) => row.founderQuestion).map((row) => row.path);
}

/* ───────────────────────────── reading the table ───────────────────────────── */

export function pageRow(path: string): PageRow | undefined {
  return PAGES.find((p) => p.path === path);
}

export function endpointRow(path: string): EndpointRow | undefined {
  return ENDPOINTS.find((e) => e.path === path);
}

/** The roles a page is open to. `ALL_STAFF` for a public page: anyone may open it. */
export function rolesWhoCanOpen(path: string): readonly StaffRole[] {
  const row = pageRow(path);
  if (!row) return [];
  return "roles" in row.access ? row.access.roles : ALL_STAFF;
}

export type PageOutcome =
  /** Render the page. */
  | "ALLOW"
  /** No session: redirect to sign-in. */
  | "SIGN_IN"
  /** Signed in, wrong role (or no role at all): the no-access page, with a 403. */
  | "NO_ACCESS"
  /** No row in this table. The guard refuses rather than guesses, and the test fails first. */
  | "UNKNOWN";

/**
 * The whole page decision, in one pure function, so the matrix test can assert every
 * role × page cell without a browser.
 */
export function pageOutcome(caller: Caller, path: string): PageOutcome {
  const row = pageRow(path);
  if (!row) return "UNKNOWN";
  if ("public" in row.access) return "ALLOW";
  if (caller.kind === "ANONYMOUS") return "SIGN_IN";
  if ("signedIn" in row.access) return "ALLOW";
  if (caller.kind === "NO_ROLE") return "NO_ACCESS";
  return row.access.roles.includes(caller.role) ? "ALLOW" : "NO_ACCESS";
}

export function canOpenPage(caller: Caller, path: string): boolean {
  return pageOutcome(caller, path) === "ALLOW";
}

export type ApiOutcome =
  | "ALLOW"
  /** No session: JSON 401. */
  | "UNAUTHENTICATED"
  /** Signed in, not this role: JSON 403. */
  | "FORBIDDEN"
  /** This route does not take a session at all (cron secret, queue callback, Auth.js). */
  | "NOT_A_SESSION_ROUTE"
  | "UNKNOWN";

/** The session half of the API decision. Non-session routes answer `NOT_A_SESSION_ROUTE`. */
export function apiOutcome(caller: Caller, path: string): ApiOutcome {
  const row = endpointRow(path);
  if (!row) return "UNKNOWN";
  if (row.auth.kind === "public") return "ALLOW";
  if (row.auth.kind !== "session") return "NOT_A_SESSION_ROUTE";
  if (caller.kind === "ANONYMOUS") return "UNAUTHENTICATED";
  if (caller.kind === "NO_ROLE") return "FORBIDDEN";
  return row.auth.roles.includes(caller.role) ? "ALLOW" : "FORBIDDEN";
}

/* ───────────────────────────── where a role lives ───────────────────────────── */

/**
 * The order a role's own pages are offered in. The first entry a role may open is their home —
 * so a director and a coordinator land on the board, and the front desk, who may open no
 * console page, lands on a screen of their own rather than on a refusal.
 *
 * **The front desk's home is the live map**, Firia's final ruling of 2026-10-17 3:08 PM ET:
 * "Front desk gets two tabs, Live map (their home) and Ramp iPad." That is why `/live-map` sits
 * ahead of `/ramp-ipad` here — it used to be the other way round, and sign-in, `/` and every
 * "send them home" redirect read this one list, so moving it moves all of them at once.
 */
const HOME_ORDER = ["/today", "/exceptions", "/setup", "/health", "/plan-routes", "/live-map", "/ramp-ipad", "/whoami"] as const;

/** Where this caller is sent when they need somewhere to be: their own first page, or sign-in. */
export function homePathFor(caller: Caller): string {
  if (caller.kind !== "STAFF") return "/login";
  return HOME_ORDER.find((path) => canOpenPage(caller, path)) ?? "/login";
}

/** The words that destination already uses, for the link that goes there. */
export function pageLabel(path: string): string {
  return pageRow(path)?.label ?? "";
}

/**
 * The caller as the map pane's data matrix sees them (src/domain/access/map-view.ts): a role, or
 * ANONYMOUS. A caller who is signed in but holds no role is ANONYMOUS to that matrix — it has no
 * row for "signed in and nothing else", and an empty data set is the right answer for one.
 */
export function mapViewerOf(caller: Caller): MapViewer {
  return caller.kind === "STAFF" ? caller.role : "ANONYMOUS";
}

/** The nav rail, filtered to what this role may actually open. Hiding is a courtesy, not the guard. */
export function canSeeNavItem(caller: Caller, href: string): boolean {
  return canOpenPage(caller, href);
}

/* ───────────────────────────── the no-access line ───────────────────────────── */

/**
 * "Directors and coordinators can open this." — generated from the row, in the roles' own
 * human names, so the sentence cannot drift from the guard. Sentence-cased at the front and
 * lower case after it, because this is prose, not a list of enum values.
 */
export function whoCanOpenLine(path: string): string {
  const roles = ROLE_LADDER.filter((role) => rolesWhoCanOpen(path).includes(role));
  if (roles.length === 0) return noAccess.whoCanOpenNobody;
  const names = roles.map((role) => roleNames[role].many);
  const first = `${names[0].charAt(0).toUpperCase()}${names[0].slice(1)}`;
  const rest = names.slice(1);
  const who =
    rest.length === 0
      ? first
      : [first, ...rest.slice(0, -1)].join(noAccess.listSeparator) + noAccess.listAnd + rest[rest.length - 1];
  return fill(noAccess.whoCanOpen, { who });
}
