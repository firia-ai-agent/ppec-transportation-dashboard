import { getNeonDb } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { ingestInbound, parseInboundForm, SIM_SIGNATURE_HEADER, verifySimWebhook } from "@/modules/messaging/inbound";
import { vercelQueueOutboxTransport } from "@/modules/outbox/transport";

export const dynamic = "force-dynamic";
export const maxDuration = 10; // Ingest group (ARCHITECTURE §2); MSG-01 p95 ingest→persist < 2 s

/**
 * Inbound SMS. In P1 the persona phones post here with a sim HMAC header (ADR-006); the Twilio adapter would
 * post the same body with X-Twilio-Signature and only the verification line changes.
 * The response says what happened to the sim panel; it never carries a phone number or a body.
 *
 * Ingest writes (the message row, a consent event, a suppression, a staff task), so on previews it refuses
 * instead: previews share the one production DB read-only (DECISION-LEDGER #43), where every statement runs
 * inside BEGIN READ ONLY and the first INSERT would fail in Postgres. Refusing after the signature check and
 * before the DB keeps the answer the same shape the sim panel already handles, and an unsigned post is still
 * a 401 on a preview — the guard must not become a way to skip verification.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySimWebhook(raw, req.headers.get(SIM_SIGNATURE_HEADER), process.env.SIM_WEBHOOK_SECRET)) {
    return Response.json({ ok: false, error: "SIGNATURE_INVALID" }, { status: 401 });
  }
  const skip = previewSkip(process.env);
  if (skip) return Response.json({ ok: false, error: "READ_ONLY", detail: skip.reason }, { status: 503 });
  const parsed = parseInboundForm(new URLSearchParams(raw));
  if ("error" in parsed) return Response.json({ ok: false, error: "BAD_REQUEST", detail: parsed.error }, { status: 400 });
  const pepper = process.env.HMAC_PEPPER;
  if (!pepper) return Response.json({ ok: false, error: "NOT_CONFIGURED" }, { status: 503 });
  const r = await ingestInbound(getNeonDb(), { pepper, transport: vercelQueueOutboxTransport }, raw, parsed.form);
  return Response.json(r.body, { status: r.status });
}
