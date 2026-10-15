import { healthPayload, readDbRole } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * The deployment probe (README). `dbRole` is the one field that needs the database — one
 * `SELECT current_user`, and `null` rather than a failed probe when it cannot be read.
 */
export async function GET() {
  return Response.json(healthPayload(process.env, await readDbRole()), {
    headers: { "cache-control": "no-store" },
  });
}
