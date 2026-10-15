/**
 * The server-side guard every page and the console layout call, first thing.
 *
 * It is the only thing standing between a URL and a surface: hiding a nav link is a courtesy
 * to the person holding the iPad, not a guard, and `proxy.ts` is explicitly not the
 * authorization layer (ADR-004). The answer comes from the one access table
 * (src/auth/access.ts) and the caller comes from the one session reader (src/auth/caller.ts),
 * so a page cannot hold an opinion of its own about who may open it.
 *
 * Three outcomes, each a real HTTP answer rather than an empty screen:
 *  - allowed → the caller, so the page can render for the role it just checked;
 *  - no session → `redirect("/login")`, a 307 to sign-in;
 *  - signed in, not this role (or a path with no row at all) → `forbidden()`, which is a real
 *    **403** carrying the nearest `forbidden.tsx`: the no-access page, which says who the page
 *    is for and nothing else. A path with no row is treated as closed, so forgetting to add a
 *    row fails shut; `access.test.ts` fails first, before anyone can reach it.
 *
 * One Next 16 behaviour worth knowing, measured on a production build of this branch: an
 * interrupt thrown outside a Suspense boundary makes React discard the HTML shell, so the
 * no-access card reaches the browser in the flight payload and is rendered there rather than
 * server-rendered (the status line and the headers are the server's either way, and a browser
 * shows the card). Putting a `loading.tsx` beside the page restores the server-rendered shell —
 * and turns the response into a **200**, because the shell is flushed before the guard refuses.
 * The status code is the half a monitor, a crawler and a test can read, so it is the half kept.
 */
import { forbidden, redirect } from "next/navigation";
import { pageOutcome } from "@/auth/access";
import { getCaller, type ResolvedCaller } from "@/auth/caller";

/**
 * Guards one page. `path` is the route's own path, which is also its key in the access table.
 *
 * Returns the caller on success, so a page that renders differently per role (the map preview)
 * reads the role from the same lookup that just authorized it, with no second session read.
 */
export async function requirePage(path: string): Promise<ResolvedCaller> {
  const caller = await getCaller();
  const outcome = pageOutcome(caller, path);
  if (outcome === "ALLOW") return caller;
  if (outcome === "SIGN_IN") redirect("/login");
  forbidden();
}
