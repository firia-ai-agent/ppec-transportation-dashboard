import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEMO_ACCOUNTS, DEMO_SHARED_PASSWORD } from "@/auth/demo-accounts";
import { demoLogins, fill, login } from "@/ui/copy";
import { showDemoLogins } from "@/lib/env";
import { fillLoginForm, type LoginFormFields } from "./fill-form";
import { visibleDemoLogins } from "./demo-logins";

/**
 * Demo logins on /login (founder decision, DECISION-LEDGER rows 57 and 59: the three accounts
 * share one password, which the page prints beside each email).
 *
 * The page is rendered for real with `renderToStaticMarkup`; `@/auth` is stubbed, so no token
 * is decoded and no database is opened. There is no DOM here (vitest runs in node), so the
 * fill itself is tested through `fillLoginForm`, which takes the three elements structurally —
 * a plain object stands in for an input — and the rules that live in CSS are asserted by
 * reading login.module.css.
 */
vi.mock("@/auth", () => ({ signIn: vi.fn() }));
// next-auth's entry point reaches for next/server, which only resolves inside Next's bundler.
// The page only uses the error class, to tell a bad password from a real failure.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));

/**
 * The three per-role env vars row 59 retired. They are canaries now: a deployment may still
 * carry them, and neither a name nor a value may reach the page (the values here are invented
 * for this test, and nothing reads a real environment).
 */
const RETIRED_ENV: Record<string, string> = {
  DEMO_DIRECTOR_PASSWORD: "director-demo-password-aaaa",
  DEMO_COORDINATOR_PASSWORD: "coordinator-demo-password-bbbb",
  DEMO_FRONT_DESK_PASSWORD: "frontdesk-demo-password-cccc",
};

/**
 * Every other variable a real deployment carries, each with a value long and odd enough that
 * finding it in the markup can only mean it leaked (ARCHITECTURE §5 lists the real names).
 */
const OTHER_ENV: Record<string, string> = {
  AUTH_SECRET: "canary-auth-secret-nnnnnnnn",
  DATABASE_URL: "postgres://canary-user:canary-pass@canary-host/canary-db",
  DATABASE_URL_UNPOOLED: "postgres://canary-user:canary-pass@canary-host-unpooled/canary-db",
  CRON_SECRET: "canary-cron-secret-nnnnnnnn",
  HMAC_PEPPER: "canary-hmac-pepper-nnnnnnnn",
  DATA_KEY: "canary-data-key-nnnnnnnn",
  OPENROUTER_API_KEY: "canary-openrouter-key-nnnnnnnn",
  SIM_WEBHOOK_SECRET: "canary-sim-webhook-nnnnnnnn",
  NEXT_PUBLIC_MAP_TILE_URL: "https://canary.example.com/tiles",
  DEMO_EXTRA_PASSWORD: "canary-unlisted-password-nnnnnnnn",
  VERCEL_ENV: "production",
  ...RETIRED_ENV,
};

const ON = { DEMO_MODE: "1", APP_DATA_CLASS: "SYNTHETIC" };

/** Kept while the env is swapped: React and node itself read these during a render. */
const KEEP = new Set(["NODE_ENV", "PATH", "HOME", "TZ"]);

let saved: Record<string, string | undefined> = {};

beforeAll(() => {
  saved = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
});

function setEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) if (!KEEP.has(key)) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
}

async function renderLogin(env: Record<string, string | undefined>): Promise<string> {
  setEnv(env);
  const { default: LoginPage } = await import("./page");
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
}

const CSS = readFileSync(path.join(__dirname, "login.module.css"), "utf8");
const PAGE = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const CARDS = readFileSync(path.join(__dirname, "DemoLogins.tsx"), "utf8");
const FILL = readFileSync(path.join(__dirname, "fill-form.ts"), "utf8");

const TITLES = ["Director", "Coordinator", "Front desk"];

describe("the copy lives in src/ui/copy.ts", () => {
  it("names the divider, the button and the announcement", () => {
    expect(demoLogins.divider).toBe("Or use a demo account");
    expect(demoLogins.use).toBe("Use this account");
    expect(fill(demoLogins.filled, { role: "Director" })).toBe("Director account filled");
  });

  it("titles the three roles the way the product says them, not the way the database does", () => {
    expect(DEMO_ACCOUNTS.map((a) => demoLogins.roles[a.role].title)).toEqual(TITLES);
    for (const title of TITLES) expect(title).not.toMatch(/_|FRONT_DESK/);
  });

  it("gives each role one plain line about that view", () => {
    for (const account of DEMO_ACCOUNTS) {
      const description = demoLogins.roles[account.role].description;
      expect(description.length).toBeGreaterThan(20);
      expect(description.split(". ")).toHaveLength(1);
    }
  });

  it("keeps the visible button words inside the accessible name (label in name, §9)", () => {
    expect(demoLogins.useRole).toContain(demoLogins.use);
    expect(fill(demoLogins.useRole, { role: "Front desk" })).toBe("Use this account, Front desk");
  });

  it("reuses the form's own field labels on the cards", () => {
    expect(demoLogins.emailLabel).toBe(login.emailLabel);
    expect(demoLogins.passwordLabel).toBe(login.passwordLabel);
  });

  it("holds no copy of its own in the card component", () => {
    expect(CARDS).toMatch(/from "@\/ui\/copy"/);
    expect(CARDS).not.toMatch(/"Or use a demo account"|"Use this account"/);
  });
});

describe("one shared demo-accounts config", () => {
  it("is the list the seed reads", () => {
    const seed = readFileSync(path.join(__dirname, "..", "..", "auth", "seed.ts"), "utf8");
    expect(seed).toMatch(/import \{ DEMO_ACCOUNTS, DEMO_SHARED_PASSWORD \} from "\.\/demo-accounts"/);
    expect(seed).not.toMatch(/director@example\.com/);
  });

  it("is the list the page reads", () => {
    const source = readFileSync(path.join(__dirname, "demo-logins.ts"), "utf8");
    expect(source).toMatch(/from "@\/auth\/demo-accounts"/);
    expect(source).not.toMatch(/director@example\.com|DEMO_DIRECTOR_PASSWORD/);
  });

  it("names one password for all three accounts (row 59)", () => {
    expect(DEMO_SHARED_PASSWORD).toBe("PPEC");
    const passwords = visibleDemoLogins({ ...ON }).map((a) => a.password);
    expect(passwords).toEqual([DEMO_SHARED_PASSWORD, DEMO_SHARED_PASSWORD, DEMO_SHARED_PASSWORD]);
    expect(new Set(passwords).size).toBe(1);
  });

  it("carries the role icon, and no password of its own per account", () => {
    for (const account of DEMO_ACCOUNTS) {
      expect(account.icon).toMatch(/^[a-z-]+$/);
      expect(Object.keys(account)).toEqual(["id", "email", "name", "role", "icon"]);
    }
  });

  it("keeps reading no environment for the password: the retired env vars change nothing", () => {
    const withRetired = visibleDemoLogins({ ...ON, ...RETIRED_ENV });
    expect(withRetired.map((a) => a.password)).toEqual(Array(3).fill(DEMO_SHARED_PASSWORD));
    const source = readFileSync(path.join(__dirname, "demo-logins.ts"), "utf8");
    // Nothing is looked up in the environment here beyond the two flags, which `showDemoLogins`
    // owns: no `env[...]`, and no leftover of the per-role mechanism.
    expect(source).not.toMatch(/passwordEnv|env\[/);
    for (const name of Object.keys(RETIRED_ENV)) expect(source).not.toContain(name);
  });
});

describe("both switches, or nothing", () => {
  it.each([
    { name: "demo mode on, synthetic data", env: ON, expected: 3 },
    { name: "demo mode off", env: { DEMO_MODE: "0", APP_DATA_CLASS: "SYNTHETIC" }, expected: 0 },
    { name: "demo mode unset", env: { APP_DATA_CLASS: "SYNTHETIC" }, expected: 0 },
    { name: "real data", env: { DEMO_MODE: "1", APP_DATA_CLASS: "REAL" }, expected: 0 },
    { name: "data class unset", env: { DEMO_MODE: "1" }, expected: 0 },
    { name: "both off", env: {}, expected: 0 },
  ])("$name renders $expected cards", async ({ env, expected }) => {
    const html = await renderLogin({ ...env, ...RETIRED_ENV });
    expect(html.match(/type="button"/g) ?? []).toHaveLength(expected);
    for (const title of expected ? TITLES : []) expect(html).toContain(title);
    if (expected === 0) {
      expect(html).not.toContain(demoLogins.divider);
      expect(html).not.toContain(DEMO_SHARED_PASSWORD);
      expect(html).not.toContain(demoLogins.shared);
    }
  });

  it("asks src/lib/env.ts the question, rather than reading the flags itself", () => {
    const source = readFileSync(path.join(__dirname, "demo-logins.ts"), "utf8");
    expect(source).toMatch(/import \{ showDemoLogins \} from "@\/lib\/env"/);
    expect(source).not.toMatch(/DEMO_MODE|APP_DATA_CLASS/);
    expect(showDemoLogins({ ...ON })).toBe(true);
  });

  it("keeps the plain sign-in form whichever way the flags are off", async () => {
    const html = await renderLogin({ DEMO_MODE: "0", APP_DATA_CLASS: "SYNTHETIC" });
    expect(html).toContain(login.submit);
    expect(html.match(/<input /g)).toHaveLength(2);
  });
});

describe("one password, listed against all three emails (row 59)", () => {
  it("lists each demo email with the shared password, and says once that it is shared", async () => {
    const html = await renderLogin({ ...ON });
    for (const account of DEMO_ACCOUNTS) expect(html).toContain(account.email);
    expect(html.split(DEMO_SHARED_PASSWORD).length - 1).toBe(3);
    expect(html.split(demoLogins.shared).length - 1).toBe(1);
  });

  it("offers all three whatever the environment carries, because no card needs a value from it", () => {
    expect(visibleDemoLogins({ ...ON })).toHaveLength(3);
    expect(visibleDemoLogins({ ...ON, ...RETIRED_ENV, ...OTHER_ENV })).toHaveLength(3);
    expect(visibleDemoLogins({})).toHaveLength(0);
  });

  it("is the same password the seed and the migration hash", () => {
    const seed = readFileSync(path.join(__dirname, "..", "..", "auth", "seed.ts"), "utf8");
    expect(seed).toMatch(/bcrypt\.hash\(DEMO_SHARED_PASSWORD, 12\)/);
    // The hash itself is pinned against PGlite in src/db/demo-password.test.ts; here we only
    // hold that neither surface carries a second, typed-out copy of the password.
    expect(seed).not.toContain(`"${DEMO_SHARED_PASSWORD}"`);
  });
});

describe("the shared password is on the page; nothing from the environment is", () => {
  it("renders the shared password and no env value at all", async () => {
    const html = await renderLogin({ ...ON, ...OTHER_ENV });
    expect(html).toContain(DEMO_SHARED_PASSWORD);
    const leaked = Object.entries(process.env)
      .filter(([, value]) => value !== undefined && value.length >= 8 && html.includes(value))
      .map(([name]) => name);
    expect(leaked).toEqual([]);
  });

  it("names no env var on screen, and never the word the flags are spelled with", async () => {
    const html = await renderLogin({ ...ON, ...OTHER_ENV });
    for (const name of [...Object.keys(OTHER_ENV), "DEMO_MODE", "APP_DATA_CLASS"]) {
      expect(html).not.toContain(name);
    }
    expect(html).not.toContain("DEMO_");
    expect(html).not.toMatch(/process\.env|env\[/);
  });

  it("reads them server-side, per request, through the page itself", () => {
    expect(PAGE).toMatch(/export const dynamic = "force-dynamic"/);
    expect(PAGE).toMatch(/visibleDemoLogins\(\)/);
    // No password or env name travels to the client component beyond the chosen accounts.
    expect(CARDS).not.toMatch(/process\.env|passwordEnv/);
  });

  it("writes the shared password in one place: the demo-accounts config", () => {
    const config = readFileSync(path.join(__dirname, "..", "..", "auth", "demo-accounts.ts"), "utf8");
    const copySource = readFileSync(path.join(__dirname, "..", "..", "ui", "copy.ts"), "utf8");
    const LIST = readFileSync(path.join(__dirname, "demo-logins.ts"), "utf8");
    const quoted = `"${DEMO_SHARED_PASSWORD}"`;
    expect(config.split(quoted).length - 1).toBe(1);
    // Not in the page, the cards, the fill, the list that builds them, or the copy file: they
    // all take the value from the config, so a change there is a change everywhere.
    for (const source of [PAGE, CARDS, FILL, LIST, copySource]) expect(source).not.toContain(quoted);
    // The retired env values are still nowhere in the feature either.
    for (const source of [config, PAGE, CARDS, FILL, LIST]) {
      for (const value of Object.values(RETIRED_ENV)) expect(source).not.toContain(value);
      expect(source).not.toContain("passwordEnv");
    }
  });
});

describe("a card fills the form and never submits it", () => {
  it("is a type=button, next to the one submit", async () => {
    const html = await renderLogin({ ...ON });
    expect(html.match(/type="button"/g)).toHaveLength(3);
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(CARDS).toMatch(/type="button"/);
  });

  it("puts the account in the two fields and moves focus to Sign in", () => {
    const fields = fieldsSpy();
    const announcement = fillLoginForm(fields.fields, visibleDemoLogins({ ...ON })[0]);
    expect(fields.email.value).toBe("director@example.com");
    expect(fields.password.value).toBe(DEMO_SHARED_PASSWORD);
    expect(fields.focused).toBe(1);
    expect(announcement).toBe("Director account filled");
  });

  it("announces the role that was actually filled, for each role", () => {
    for (const account of visibleDemoLogins({ ...ON })) {
      const fields = fieldsSpy();
      const title = demoLogins.roles[account.role].title;
      expect(fillLoginForm(fields.fields, account)).toBe(`${title} account filled`);
      expect(fields.email.value).toBe(account.email);
    }
  });

  it("survives a form that is missing a field, rather than throwing on a click", () => {
    const empty: LoginFormFields = { email: null, password: null, submit: null };
    expect(fillLoginForm(empty, visibleDemoLogins({ ...ON })[0])).toBe(
      "Director account filled",
    );
  });

  it("calls nothing that could submit", () => {
    expect(FILL).not.toMatch(/requestSubmit|\.submit\(|click\(\)/);
    expect(CARDS).not.toMatch(/requestSubmit|onSubmit|\.submit\(/);
  });
});

describe("the ear gets the same page as the eye (§9)", () => {
  it("gives each button an accessible name carrying its role", async () => {
    const html = await renderLogin({ ...ON });
    for (const title of TITLES) {
      expect(html).toContain(`aria-label="${fill(demoLogins.useRole, { role: title })}"`);
    }
    expect(html.match(/aria-label="Use this account/g)).toHaveLength(3);
  });

  it("announces the fill in a polite live region that is in the markup from the start", async () => {
    const html = await renderLogin({ ...ON });
    expect(html).toMatch(/class="srOnly" role="status" aria-live="polite"/);
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  it("labels the section with the divider text and hides the icons from the reader", async () => {
    const html = await renderLogin({ ...ON });
    expect(html).toMatch(/<section class="[^"]*" aria-labelledby="[^"]+">/);
    expect(html).toContain(demoLogins.divider);
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(3);
  });

  it("labels each credential, so a value is never read without saying which field it is", async () => {
    const html = await renderLogin({ ...ON });
    expect(html.match(new RegExp(`>${demoLogins.emailLabel}</dt>`, "g"))).toHaveLength(3);
    expect(html.match(new RegExp(`>${demoLogins.passwordLabel}</dt>`, "g"))).toHaveLength(3);
  });
});

describe("Vera's layout bar", () => {
  it("sits under the Sign in button, inside the same card column", () => {
    const submitAt = PAGE.indexOf("type=\"submit\"");
    expect(submitAt).toBeGreaterThan(0);
    expect(PAGE.indexOf("<DemoLogins")).toBeGreaterThan(submitAt);
    // One 380 px column, and no media query widens or re-columns it: 1024 and 1440 are identical.
    expect(CSS).toMatch(/max-width: 380px/);
    expect(CSS).not.toMatch(/@media/);
    expect(CSS).toMatch(/\.cards \{[^}]*flex-direction: column/);
  });

  it("keeps the blue Sign in button the only primary", () => {
    const use = CSS.slice(CSS.indexOf(".use {"));
    expect(use).toMatch(/background: var\(--color-surface\)/);
    expect(use).toMatch(/border: var\(--border-hairline\) solid var\(--color-brand\)/);
    expect(use).toMatch(/color: var\(--color-brand\)/);
    expect(CSS).toMatch(/\.submit \{[^}]*background: var\(--color-brand\)/);
  });

  it("shows the credentials in the mono face, copy-style", () => {
    expect(CARDS).toMatch(/mono/);
    expect(CSS).toMatch(/\.creds \{[^}]*grid-template-columns: auto 1fr/);
  });

  it("uses no violet: that colour is the DEMO bar's alone", () => {
    expect(CSS).not.toMatch(/demo-bg|demo-fg|src-sim/);
  });

  it("styles everything from tokens (no-hex.test.ts covers the literals)", () => {
    const declarations = [...CSS.matchAll(/^\s{2}(?:background|color|border|border-color):\s*(.+);$/gm)];
    expect(declarations.length).toBeGreaterThan(5);
    for (const [, value] of declarations) expect(value).toMatch(/var\(--/);
  });

  it("gives the fill button a console-sized target (§9)", () => {
    expect(CSS.slice(CSS.indexOf(".use {"))).toMatch(/min-height: var\(--target-console\)/);
  });
});

/** An input and a button, as far as `fillLoginForm` is concerned. */
function fieldsSpy() {
  const email = { value: "" };
  const password = { value: "" };
  const spy = { email, password, focused: 0, fields: {} as LoginFormFields };
  spy.fields = { email, password, submit: { focus: () => (spy.focused += 1) } };
  return spy;
}
