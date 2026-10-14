import { healthPayload } from "@/lib/health";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(healthPayload(process.env), { headers: { "cache-control": "no-store" } });
}
