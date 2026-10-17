/**
 * The 403 boundary for the redirect at /map-preview: a signed-in person whose role cannot open
 * the live map sees the same no-access card here as at /live-map, rather than being bounced to a
 * screen that would refuse them. The path below is this route's key in the access table
 * (src/auth/access.ts), which is where the "who can open this" sentence is generated from.
 */
import { NoAccess } from "@/ui/NoAccess";

export default function Forbidden() {
  return <NoAccess path="/map-preview" />;
}
