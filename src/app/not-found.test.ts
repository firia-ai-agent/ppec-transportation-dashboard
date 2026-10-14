import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { login, nav, notFound } from "@/ui/copy";

/**
 * The 404 offers exactly one way out, and which one depends only on whether there is a session.
 *
 * `auth()` is stubbed, so no token is decoded and no database is opened; `next/link` is stubbed
 * to a plain anchor, because the real one wants a router from React context that exists only
 * inside Next. What is asserted is this page's own structure: one <h1>, one link, the right
 * href and the right label.
 */
const auth = vi.fn<() => Promise<{ user?: { id?: string } } | null>>();
vi.mock("@/auth", () => ({ auth }));
vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", props),
}));

const SIGNED_IN = { user: { id: "00000000-0000-7000-8000-0000000000d1" } };

beforeEach(() => auth.mockReset());

/** React escapes `'` in a text node, so the copy has to be escaped to be found in the markup. */
function escapeApostrophes(text: string): string {
  return text.replace(/'/g, "&#x27;");
}

async function render(session: { user?: { id?: string } } | null): Promise<string> {
  auth.mockResolvedValue(session);
  const { default: NotFound } = await import("./not-found");
  return renderToStaticMarkup(await NotFound());
}

describe("the copy lives in src/ui/copy.ts", () => {
  it("says the one line, in product voice: calm, plain, no apology", () => {
    expect(notFound.heading).toBe("This page doesn't exist.");
    expect(notFound.heading).not.toMatch(/!|sorry|error|404/i);
  });

  it("labels each way out with the words that destination already uses", () => {
    expect(notFound.today).toBe(nav.today);
    expect(notFound.signIn).toBe(login.submit);
  });

  it("holds no copy of its own in the component", () => {
    const source = readFileSync(path.join(__dirname, "not-found.tsx"), "utf8");
    expect(source).toMatch(/from "@\/ui\/copy"/);
    expect(source).toMatch(/copy\.heading/);
  });
});

describe("the page", () => {
  it("renders the line as the page's h1", async () => {
    const html = await render(SIGNED_IN);
    // Class names are hashed by the CSS-module transform, so assert the element, not the class.
    expect(html).toContain(`${escapeApostrophes(notFound.heading)}</h1>`);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("offers Today, and only Today, to a signed-in visitor", async () => {
    const html = await render(SIGNED_IN);
    expect(html).toContain(`href="/today"`);
    expect(html).toContain(`>${nav.today}</a>`);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("offers Sign in, and only Sign in, to everyone else", async () => {
    for (const session of [null, {}, { user: {} }]) {
      const html = await render(session);
      expect(html).toContain(`href="/login"`);
      expect(html).toContain(`>${login.submit}</a>`);
      expect(html.match(/<a /g)).toHaveLength(1);
      expect(html).not.toContain("/today");
    }
  });

  it("reads the session with auth(), once", async () => {
    await render(SIGNED_IN);
    expect(auth).toHaveBeenCalledTimes(1);
  });
});

describe("it sits on the sign-in shell", () => {
  const css = readFileSync(path.join(__dirname, "not-found.module.css"), "utf8");

  it("composes the card, the page frame and the heading from login.module.css", () => {
    for (const className of ["page", "card", "heading"]) {
      expect(css).toMatch(
        new RegExp(`\\.${className} \\{\\s*composes: ${className} from "\\./login/login\\.module\\.css";`),
      );
    }
  });

  it("styles the link from tokens only (no-hex.test.ts covers the colour literals)", () => {
    const link = css.slice(css.indexOf(".link"));
    expect(link).toMatch(/color: var\(--color-brand\)/);
    expect(link).toMatch(/min-height: var\(--target-console\)/);
    // Nothing removes the underline: colour is never the only cue (§9).
    expect(link).not.toMatch(/text-decoration/);
  });
});
