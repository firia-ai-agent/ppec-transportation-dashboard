/**
 * The last-resort 403 boundary, for a refusal with no page of its own to name — a signed-in user
 * who holds no membership at any site, whose refusal can happen above a page (in the console
 * layout). Every guarded page has its own boundary next to it, which is the one that says who
 * that page is for; access.test.ts holds that.
 */
import { NoAccess } from "@/ui/NoAccess";

export default function Forbidden() {
  return <NoAccess />;
}
