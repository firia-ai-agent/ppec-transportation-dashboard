import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const AT = { pathname: "/today", search: "" };
vi.mock("next/navigation", () => ({
  usePathname: () => AT.pathname,
  useSearchParams: () => new URLSearchParams(AT.search),
  useRouter: () => ({ refresh: () => {} }),
}));

import { FAMILY_TEXTS_FOR_YOU, FOR_YOU_TAB, PAGES } from "@/auth/access";
import { AgentBubble } from "./AgentBubble";
import { navItems } from "./nav-items";

/**
 * THE AGENT IS ON EVERY STAFF SCREEN BUT FAMILY TEXTS (Vera: "the Agent button only
 * shows on /today; earlier builds had it on Plan routes, Live map, Ramp iPad").
 *
 * The bubble is mounted once, by the shell every route's layout renders (src/ui/ConsoleShell.tsx,
 * and src/ui/one-menu.test.ts holds that there are four such layouts and no more), so the markup
 * was never the thing that went missing. What went missing was a *stylesheet*: a page could reach
 * past the frame with `:global([data-agent-bubble]) { display: none }` and take the agent off its
 * own screen, and two did. One of them — Family texts, whose thread **is** the agent and whose
 * compose bar the disc would otherwise sit on — is the rule. The other was the ramp iPad's, a
 * stopgap for an overlap the shared offset had already solved
 * (src/app/ramp-ipad/arrival/arrival.module.css, src/ui/sticky-action-bar.test.ts).
 *
 * So this file states the property rather than the two cases: **one page may hide the bubble, and
 * it is Family texts.** A third page that hides it fails here the day it is written, and no screen
 * has to be remembered.
 */
const UI = __dirname;
const SRC = path.resolve(UI, "..");
const REPO = path.resolve(SRC, "..");
const APP = path.join(SRC, "app");
const FAMILY_TEXTS_CSS = path.join(APP, "(app)", "family-texts", "texts.module.css");

const read = (file: string) => readFileSync(file, "utf8");

/** Every stylesheet under src/, which is every stylesheet this app ships. */
function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : stylesheets(full);
    return full.endsWith(".css") ? [full] : [];
  });
}

/** A rule that takes the bubble off the page: the selector names it and the declaration hides it. */
function hidesTheBubble(css: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]*\[data-agent-bubble\][^{}]*)\{([^}]*)\}/g)]
    .filter(([, , body]) => /display\s*:\s*none|visibility\s*:\s*hidden/.test(body))
    .map(([, selector]) => selector.trim());
}

describe("only Family texts may take the agent off a screen", () => {
  const sheets = stylesheets(SRC);

  it("has stylesheets to scan, so a broken walk cannot pass silently", () => {
    expect(sheets.length).toBeGreaterThan(5);
    expect(sheets).toContain(FAMILY_TEXTS_CSS);
  });

  it("is one hiding rule in the whole app, and it is the compose bar's", () => {
    const offenders = sheets
      .map((file) => ({ file: path.relative(REPO, file), rules: hidesTheBubble(read(file)) }))
      .filter((r) => r.rules.length > 0);
    expect(offenders.map((o) => o.file)).toEqual([path.relative(REPO, FAMILY_TEXTS_CSS)]);
    expect(offenders[0].rules).toHaveLength(1);
    expect(offenders[0].rules[0]).toContain(".composeDock");
  });

  /** The screen it was taken off: the ramp iPad clears the disc by the offset, never by hiding it. */
  it("the ramp iPad hides nothing — its Confirm bar declares a height instead", () => {
    const arrival = read(path.join(APP, "ramp-ipad", "arrival", "arrival.module.css"));
    expect(hidesTheBubble(arrival)).toEqual([]);
    expect(arrival).toMatch(/--sticky-action-bar-height/);
  });
});

/**
 * And the other half, from the component: given the role that may decide, the bubble draws itself
 * on every address on the menu except Family texts' For you tab. `agentBubbleHidden` is the one
 * function that decides it (src/ui/agent-bubble-state.ts); this calls the component, so a second
 * opinion added anywhere inside it fails here.
 */
describe("the component draws itself on every menu destination but For you", () => {
  const render = () => renderToStaticMarkup(createElement(AgentBubble, { canDecide: true }));

  it.each(navItems.map((item) => item.href))("%s draws the Agent button", (href) => {
    AT.pathname = href;
    AT.search = "";
    expect(render()).toContain("data-agent-bubble");
  });

  it("does not draw it on the For you tab, which is the thread itself", () => {
    AT.pathname = FAMILY_TEXTS_FOR_YOU.split("?")[0];
    AT.search = `?tab=${FOR_YOU_TAB}`;
    expect(render()).toBe("");
  });

  /** Every staff page there is, not only the five on the menu — /whoami, /setup, the rest. */
  it.each(
    PAGES.filter((p) => p.kind === "page")
      .map((p) => p.path)
      .filter((p) => !p.startsWith("/family-texts") && !p.startsWith("/login") && p !== "/"),
  )("%s draws it too", (href) => {
    AT.pathname = href;
    AT.search = "";
    expect(render()).toContain("data-agent-bubble");
  });

  it("the mount is still the one shell, so none of this is per-page", () => {
    expect(read(path.join(UI, "ConsoleShell.tsx"))).toMatch(/<AgentBubble\b/);
    const mounts = readdirSync(UI)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /<AgentBubble\b/.test(read(path.join(UI, f))));
    expect(mounts).toEqual(["ConsoleShell.tsx"]);
    expect(existsSync(path.join(UI, "AgentBubble.tsx"))).toBe(true);
  });
});
