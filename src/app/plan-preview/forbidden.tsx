/**
 * The 403 boundary for the redirect at /plan-preview: a signed-in person whose role cannot open
 * Plan routes sees the same no-access card here as at /plan-routes, rather than being bounced to a
 * screen that would refuse them. The path below is this route's key in the access table
 * (src/auth/access.ts), which is where the "who can open this" sentence is generated from.
 */
import { NoAccess } from "@/ui/NoAccess";

export default function Forbidden() {
  return <NoAccess path="/plan-preview" />;
}
