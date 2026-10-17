import { LAYOUT, PAGES, pageRow } from "@/auth/access";

/**
 * WHERE THE REFUSAL'S FRAME COMES FROM — the one decision behind src/ui/RefusedPage.tsx.
 *
 * Next renders a segment's `forbidden.tsx` *inside that segment's layout chain*. Measured on a
 * production build of this branch at 1440 px, 2026-10-17: a refusal under /live-map came back
 * with one `<header>` and both menus already on screen, because src/app/live-map/layout.tsx had
 * mounted the console shell before the page inside it refused — while a refusal under /whoami,
 * whose folder holds no layout, came back with no header and no menu at all. That second answer
 * is Vera's dead end (4:19 PM ET): a card, a sentence, and one link off it.
 *
 * So the shared component mounts the frame for exactly the boundaries nothing above them
 * frames, and this is that question, asked once. It is a fact about which folders hold a shell
 * layout, and the access table already holds it: every layout in the app has a row naming its
 * file. Reading those rows is what keeps this from being a second list to maintain, and
 * src/ui/refused-frame.test.ts walks the real filesystem and fails if the answer ever disagrees
 * with the layouts on disk — so a screen moved into or out of a group cannot quietly end up
 * with two frames or none.
 *
 * Pure: a path in, a boolean out. It reads no session and holds no opinion about access.
 */

/** `"src/app/(app)/today/page.tsx"` → `"src/app/(app)/today"`. */
function folderOf(file: string): string {
  return file.slice(0, file.lastIndexOf("/"));
}

/**
 * Is this page's refusal already inside the console shell, because a layout above its folder
 * mounts one?
 *
 * The root layout is excluded: it is the document shell — fonts, tokens and the DEMO bar on
 * every route, signed in or not — and it mounts no console chrome, which is why a refusal with
 * no page to name (src/app/forbidden.tsx) needs the frame from the shared component.
 */
export function shellComesFromLayout(path?: string): boolean {
  const row = path ? pageRow(path) : undefined;
  if (!row) return false;
  const folder = folderOf(row.file);
  return PAGES.some((candidate) => {
    if (candidate.kind !== "layout" || candidate.path === LAYOUT.root) return false;
    const above = folderOf(candidate.file);
    return folder === above || folder.startsWith(`${above}/`);
  });
}
