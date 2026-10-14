/**
 * Handoff seam from the inbound webhook to whatever reads a new message (ARCHITECTURE §3.1).
 *
 * B-04 ships the stub: the webhook persists evidence and stops. The agent runner (B-09) replaces the
 * implementation with one that inserts `ops.agent_run` (unique on trigger_type + trigger_id) and publishes
 * a queue wake-up after commit. It is called inside the webhook's transaction with the message already
 * written, so an agent run can never exist without its trigger message.
 *
 * It is NOT called for an unknown sender or for our own echo: a message is evidence, never authority
 * (RES-02), and an unknown number must get no reply at all (AT-09).
 */
import type { Exec } from "@/db/exec";
import type { ConsentKind } from "./consent";

export type InboundMessageEvent = {
  siteId: string;
  messageId: string;
  threadId: string;
  /** guardian_contact.contact_token or external_person_identity.person_token; never a phone number. */
  contactToken: string;
  familyGroupId: string | null;
  channel: string;
  /** Contact details already replaced by markers (identity/phone.tokenizeBody). */
  bodyTokenized: string;
  receivedAt: Date;
  providerIndex: number | null;
  consentKind: ConsentKind | null;
};

export type InboundMessageHook = (tx: Exec, event: InboundMessageEvent) => Promise<void>;

/** P1 default: record and stop. No LLM call anywhere in B-04. */
export const noopInboundMessageHook: InboundMessageHook = async () => {};
