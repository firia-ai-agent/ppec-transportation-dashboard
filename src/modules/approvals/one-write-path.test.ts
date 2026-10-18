/**
 * **Firia's gate 1 and gate 2**: one write path, and an edit that never sends.
 *
 * ## Gate 1 — Approve, Edit and Don't send each call only `decideApproval`
 *
 * Asserted two ways, because each alone would be weak. **By spying**: the real server action is
 * driven for each control and `decideApproval` is the function that runs, with the decision the
 * control stands for — so there is no second code path for "approve" versus "decline". **By
 * reading the source**: the action is five lines of plumbing with no query, no insert, no update
 * and no `enqueue` in it, so there is nowhere else for a write to be hiding. The spy proves what
 * is called; the scan proves nothing else is.
 *
 * (The strongest form of this is already held elsewhere and is cited rather than repeated:
 * `free-text-egress.test.ts` part 1 scans the whole tree and names every caller of
 * `outbox.enqueue`, and asserts that none of them is a route or a server action.)
 *
 * ## Gate 2 — an edited message needs a fresh approval
 *
 * Edit is a **navigation**. The control is a `GET` form to the same screen with `?time=`, the page
 * re-renders the proposal with the new time through the decision model's own renderer, and the
 * card comes back *pending*: still "Approve and send", still "the family hears nothing until you
 * approve". Nothing is claimed and nothing is queued, so the edited words are a proposal a person
 * still has to sign. An Edit that approved-with-a-different-time would be a send nobody signed.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoDay } from "@/domain/board/day";
import { demoChangeRequests, withRequestedTime } from "@/modules/demo/change-request";
import { demoLateDropoffs } from "@/modules/demo/late-dropoff";
import { approval } from "@/ui/copy";
import type { DecisionState } from "@/app/(app)/family-texts/actions";

const REPO = process.cwd();
const ACTION_FILE = path.join(REPO, "src", "app", "(app)", "family-texts", "actions.ts");
const CARD_FILE = path.join(REPO, "src", "app", "(app)", "family-texts", "ProposalCard.tsx");

/** The decision model, with the one entry point spied on and everything else real. */
const decideApproval = vi.fn();
vi.mock("@/modules/approvals/decide", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/approvals/decide")>();
  return { ...real, decideApproval: (...args: unknown[]) => decideApproval(...args) };
});

/** A director, so the action's own role check passes and the call reaches the model. */
const getCaller = vi.fn(async () => ({
  kind: "STAFF" as const,
  role: "DIRECTOR" as const,
  userId: "00000000-0000-7000-8000-0000000000d1",
  displayName: "SYN Dana Director",
  memberships: [],
}));
vi.mock("@/auth/caller", () => ({ getCaller: () => getCaller() }));
vi.mock("@/db/exec", () => ({ getNeonDb: () => ({}), runAfterCommit: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(() => {
  decideApproval.mockReset();
  decideApproval.mockResolvedValue({
    status: 200,
    body: { ok: true, decision: "APPROVED", text: "x", queued: 1 },
  });
});

const form = (decision: string, time = "") => {
  const f = new FormData();
  f.set("approval", "01900000-0000-7000-8000-002600000001");
  f.set("decision", decision);
  f.set("time", time);
  return f;
};

describe("gate 1: one write path for all three controls", () => {
  it("runs the decision model, and only it, for Approve and send", async () => {
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    await decideApprovalAction({ status: "idle" }, form("APPROVED"));
    expect(decideApproval).toHaveBeenCalledTimes(1);
    expect(decideApproval.mock.calls[0][2]).toMatchObject({ decision: "APPROVED" });
  });

  it("runs the same one for Don't send, with the decision that control stands for", async () => {
    decideApproval.mockResolvedValue({
      status: 200,
      body: { ok: true, decision: "DECLINED", text: "x", queued: 0 },
    });
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    await decideApprovalAction({ status: "idle" }, form("DECLINED"));
    expect(decideApproval).toHaveBeenCalledTimes(1);
    expect(decideApproval.mock.calls[0][2]).toMatchObject({ decision: "DECLINED" });
  });

  it("carries the edited time into that same call rather than a second one", async () => {
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    await decideApprovalAction({ status: "idle" }, form("APPROVED", "17:30"));
    expect(decideApproval).toHaveBeenCalledTimes(1);
    expect(decideApproval.mock.calls[0][2]).toMatchObject({ editedTime: "17:30" });
  });

  it("has no write of its own in the action at all", () => {
    const source = readFileSync(ACTION_FILE, "utf8");
    // No SQL, no outbox, no second decision function.
    expect(source).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\.query\(|\benqueue\(/i);
    // Exactly one call into the decision model.
    expect(source.match(/decideApproval\(/g) ?? []).toHaveLength(1);
  });

  it("refuses before it calls anything when the role may not decide", async () => {
    getCaller.mockResolvedValueOnce({
      kind: "STAFF",
      role: "FRONT_DESK" as unknown as "DIRECTOR",
      userId: "00000000-0000-7000-8000-0000000000f1",
      displayName: "SYN Frankie Front Desk",
      memberships: [],
    });
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    const state = await decideApprovalAction({ status: "idle" }, form("APPROVED"));
    expect(state).toEqual({ status: "refused", message: approval.notYourRole });
    expect(decideApproval).not.toHaveBeenCalled();
  });
});

describe("gate 2: an edited message needs a fresh approval", () => {
  const day = demoDay();
  const request = demoChangeRequests(day)[0];

  it("re-renders the reply from the new time, through the same template", () => {
    const edited = withRequestedTime(request, "17:30", day);
    expect(edited.requestedHhmm).toBe("17:30");
    expect(edited.timeTo).toBe("5:30 PM");
    expect(edited.draftText).not.toBe(request.draftText);
    expect(edited.draftText).toContain("5:30 PM");
    // Same template, so the words are still the outbox's and not a person's.
    expect(edited.templateId).toBe(request.templateId);
  });

  it("sends nothing: Edit is a GET navigation, not the decision", () => {
    const card = readFileSync(CARD_FILE, "utf8");
    // The Edit control's form posts nowhere: it is a `GET` to this screen with the time on it.
    expect(card).toMatch(/<form method="get" action=\{editHref\}/);
    // And the only `action={submit}` form — the one that reaches the server action — carries
    // Approve and Don't send, never Edit.
    const posted = card.slice(card.indexOf("action={submit}"));
    expect(posted).toContain("approval.approveAndSend");
    expect(posted).toContain("approval.dontSend");
    expect(posted).not.toContain("approval.edit");
  });

  it("comes back pending, with Approve still to press", async () => {
    const { TextsScreen } = await import("@/app/(app)/family-texts/TextsScreen");
    const { conversationRows, proposalFromDemo, threadView } = await import(
      "@/app/(app)/family-texts/conversations"
    );
    const texts = demoLateDropoffs(day);
    const selected = texts[texts.length - 1];
    const edited = withRequestedTime(request, "17:30", day);
    const html = renderToStaticMarkup(
      createElement(TextsScreen, {
        tab: "for-you",
        rows: conversationRows(texts, [edited]),
        thread: threadView({
          selected,
          thread: { source: "scenario", bubbles: [] },
          request: edited,
          day,
          assistantReachable: true,
          mayApprove: true,
        }),
        proposals: [proposalFromDemo(edited)],
        alerts: [],
        alertsUnreadable: false,
        assistantReachable: true,
        editedTime: "17:30",
        threadOpen: false,
        decide: async (): Promise<DecisionState> => ({ status: "idle" }),
        showForYouTab: true,
      }),
    );
    // The new time is on the card, and so is the control that would send it.
    expect(html).toContain("5:30 PM");
    expect(html).toContain(approval.approveAndSend);
    // And the family still has not been told anything.
    expect(html).toContain(approval.nothingUntilApproved);
    // The edit itself queued nothing: the decision model was never called.
    expect(decideApproval).not.toHaveBeenCalled();
  });
});
