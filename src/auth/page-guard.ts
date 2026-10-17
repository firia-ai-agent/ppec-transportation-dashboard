/**
 * The server-side guard every page and the console layout call, first thing.
 *
 * It is the only thing standing between a URL and a surface: hiding a nav link is a courtesy
 * to the person holding the iPad, not a guard, and `proxy.ts` is explicitly not the
 * authorization layer (ADR-004). The answer comes from the one access table
 * (src/auth/access.ts) and the caller comes from the one session reader (src/auth/caller.ts),
 * so a page cannot hold an opinion of its own about who may open it.
 *
 * Four outcomes, each a real HTTP answer rather than an empty screen:
 *  - allowed → the caller, so the page can render for the role it just checked;
 *  - no session → `redirect("/login")`, a 307 to sign-in;
 *  - **signed in with a role, asking for a page that role's menu does not carry → a 307 to
 *    their own home, with `?notice=not-on-your-menu`**, which the shell says as a toast
 *    (§9.3, src/ui/NoticeToast.tsx). This is the founder's dead end, closed: the refusal page
 *    on production had no way back, and "the page you asked for is not one of yours" is a
 *    sentence, not a wall. It is a courtesy about *where to go*, not a loosening of anything —
 *    the APIs still answer **403** to the same caller (src/auth/api-guard.ts), including
 *    `POST /api/demo/reset` for the front desk, and guard-matrix.test.ts asks the server
 *    directly;
 *  - signed in and holding no role anywhere (or a path with no row at all) → `forbidden()`,
 *    which is a real **403** carrying the nearest `forbidden.tsx`: the no-access page, which
 *    says who the page is for and nothing else. They have no home to be sent to — every page
 *    refuses them — so the card is the answer, and it renders inside the shell. A path with no
 *    row is treated as closed, so forgetting to add a row fails shut; `access.test.ts` fails
 *    first, before anyone can reach it.
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
import { homePathFor, pageOutcome, pageRow } from "@/auth/access";
import { getCaller, type ResolvedCaller } from "@/auth/caller";
import { NOT_ON_YOUR_MENU, withNotice } from "@/ui/notice";

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
  /*
   * A page this person's role cannot open, asked for by typing the URL. They hold a role, so
   * there is a screen of their own to be on: send them there and say why (§9.3). `homePathFor`
   * reads the same access table that just refused, so the place they land is one they may open
   * — and the row has to be a real page, or this is a URL that matches nothing and the 403 is
   * the honest answer.
   */
  if (caller.kind === "STAFF" && pageRow(path)) {
    redirect(withNotice(homePathFor(caller), NOT_ON_YOUR_MENU));
  }
  forbidden();
}
