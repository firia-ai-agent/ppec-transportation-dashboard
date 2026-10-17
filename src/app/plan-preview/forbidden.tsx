/**
 * The 403 boundary for the redirect at /plan-preview: a signed-in person whose role cannot open
 * Plan routes sees the same no-access card here as at /plan-routes, rather than being bounced to a
 * screen that would refuse them. The path below is this route's key in the access table
 * (src/auth/access.ts), which is where the "who can open this" sentence is generated from.
 *
 * The frame around the card — the header, the account menu with Sign out in it, and this role's
 * own menu — comes from the one shared component every boundary in this app renders
 * (src/ui/RefusedPage.tsx). This folder holds no layout of its own, so until 2026-10-17 the
 * card arrived here with no header and no menu at all (Vera's review, 4:19 PM ET).
 */
import { RefusedPage } from "@/ui/RefusedPage";

export default function Forbidden() {
  return <RefusedPage path="/plan-preview" />;
}
