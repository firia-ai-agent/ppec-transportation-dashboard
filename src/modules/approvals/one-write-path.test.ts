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
 * ## Gate 2 — an edited message is approved by the press that sends it
 *
 * Edit is a **navigation**: a link to the same screen with `?edit=<approval id>`. The card comes back
 * *pending* with the reply's own words in a text box inside the Approve form, so the words a
 * coordinator types travel only in that POST — never in a URL — and nothing is claimed or queued
 * until Approve & send is pressed. Edit = the message text (user ruling, 2026-10-18): the words go
 * out in the reply's one free-text slot, held to the model's own reply rule.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoDay } from "@/domain/board/day";
import { demoChangeRequests } from "@/modules/demo/change-request";
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

const form = (decision: string, edited?: string) => {
  const f = new FormData();
  f.set("approval", "01900000-0000-7000-8000-002600000001");
  f.set("decision", decision);
  if (edited !== undefined) f.set("edited", edited);
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

  it("carries the edited words into that same call rather than a second one", async () => {
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    await decideApprovalAction({ status: "idle" }, form("APPROVED", "See you at 5."));
    expect(decideApproval).toHaveBeenCalledTimes(1);
    expect(decideApproval.mock.calls[0][2]).toMatchObject({ editedText: "See you at 5." });
  });

  it("has no write of its own in the decision action at all", () => {
    const source = readFileSync(ACTION_FILE, "utf8");
    /*
     * Scoped to `decideApprovalAction`'s own body, because this file holds a second action now:
     * `takeAlertAction`, which marks a "needs a person" alert taken (Firia's S1-4,
     * 2026-10-18 12:13 AM ET). That is a different row and a different decision — a task state,
     * not an approval — and it has its own write, `openAlert`, held to its own rules in
     * `app/(app)/family-texts/alert-taken-on-post.test.ts`. What gate 1 is about is the
     * APPROVAL: that there is no second path from a button to a plan change or a text.
     */
    const body = bodyOf(source, "decideApprovalAction");
    expect(body).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\.query\(|\benqueue\(/i);
    // Exactly one call into the decision model, from the whole file.
    expect(source.match(/decideApproval\(/g) ?? []).toHaveLength(1);
    // And the other action cannot decide an approval or send anything.
    const take = bodyOf(source, "takeAlertAction");
    expect(take).not.toMatch(/decideApproval\(|\benqueue\(|outbox/i);
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

/**
 * **A send is refused while the message is waiting for a person** (Veri's bar, 2026-10-17).
 *
 * The compose bar's Send *is* the approval when a proposal is open (Firia's gate 3): a
 * coordinator who has read the drafted reply and presses it has signed it, and that press runs
 * `decideApproval` like every other control. What this suite holds is the other half — there is
 * no press, no form and no code path that puts a waiting message on a family's phone *without*
 * that call. Not from the bar with nothing open, not from a form with a decision missing, and
 * not from anything on the screen but the three controls.
 */
describe("a send is refused while the message awaits approval", () => {
  it("does nothing at all when the form names no decision", async () => {
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    const f = new FormData();
    f.set("approval", "01900000-0000-7000-8000-002600000001");
    // No `decision`: the bar with nothing open posts this, and nothing may come of it.
    expect(await decideApprovalAction({ status: "idle" }, f)).toEqual({ status: "idle" });
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("does nothing when a decision names no approval", async () => {
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    const f = new FormData();
    f.set("decision", "APPROVED");
    expect(await decideApprovalAction({ status: "idle" }, f)).toEqual({ status: "idle" });
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("refuses a decision this app does not have", async () => {
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    // "SEND" is not one of the two decisions. A third word is not a third write path.
    expect(await decideApprovalAction({ status: "idle" }, form("SEND"))).toEqual({ status: "idle" });
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("has no second way to release one: the screen posts to this action and nothing else", () => {
    const card = readFileSync(CARD_FILE, "utf8");
    const composer = readFileSync(
      path.join(REPO, "src", "app", "(app)", "family-texts", "Composer.tsx"),
      "utf8",
    );
    // Every form on either component submits the injected action; none posts to a URL.
    for (const [name, source] of [["card", card], ["composer", composer]] as const) {
      const forms = [...source.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
      expect(forms.length, name).toBeGreaterThan(0);
      for (const tag of forms) {
        const posts = tag.includes("action={submit}");
        const navigates = tag.includes('method="get"');
        expect(posts || navigates, `${name}: ${tag}`).toBe(true);
      }
    }
    // And neither one reaches the outbox or a route: the action is the only door.
    expect(card).not.toMatch(/fetch\(|enqueue\(/);
    expect(composer).not.toMatch(/fetch\(|enqueue\(/);
  });
});

describe("gate 2: an edited message is approved by the press that sends it", () => {
  const day = demoDay();
  const request = demoChangeRequests(day)[0];
  const REPLY = "Hi Dara, yes, we can drop Noah off at 5 today.";

  it("sends nothing: Edit is a link, and the text box lives inside the Approve form", () => {
    const card = readFileSync(CARD_FILE, "utf8");
    // Edit navigates; it is not a form and it posts nothing.
    expect(card).toMatch(/<Link href=\{editHref\}/);
    expect(card).not.toMatch(/method="get"/);
    const posted = [...card.matchAll(/<form action=\{submit\}([\s\S]*?)<\/form>/g)].map((m) => m[1]);
    expect(posted).toHaveLength(2);
    // The edited words ride the Approve POST and nothing else — never a query string.
    expect(posted.filter((f) => f.includes('name="edited"'))).toHaveLength(1);
    expect(card).toContain("approval.approveAndSend");
    expect(card).toContain("approval.dontSend");
  });

  it("comes back pending, the reply's own words in the box, with Approve still to press", async () => {
    const { TextsScreen } = await import("@/app/(app)/family-texts/TextsScreen");
    const { conversationRows, threadView } = await import(
      "@/app/(app)/family-texts/conversations"
    );
    const { approvalQueue } = await import("@/app/(app)/family-texts/queue");
    const { DROPOFF_CHANGE_KIND } = await import("@/modules/agent/run/exec/proposals");
    const { childTokenOf } = await import("@/modules/demo/fixtures/standard");
    const texts = demoLateDropoffs(day);
    const selected = texts[texts.length - 1];
    const site = "00000000-0000-7000-8000-0000000000a1";
    const row = {
      id: request.approvalId,
      site_id: site,
      decided_at: null,
      created_at: new Date(request.draftedAtMs),
      display_name: request.childLabel,
      proposal: {
        kind: DROPOFF_CHANGE_KIND,
        leg_id: "00000000-0000-7000-8000-0000000000f1",
        child_token: childTokenOf(request.childKey),
        service_date: day.iso,
        direction: "PM",
        plan_run_version_basis: 0,
        requested_dropoff_time: request.requestedHhmm,
        stop_token: "PBSC-LW",
        rationale_code: "PARENT_REQUEST",
        template_id: "dropoff.reply",
        vars: { ...request.vars, replyText: REPLY },
      },
    };
    const queue = await approvalQueue({
      db: { query: async () => ({ rows: [row] as never[] }) },
      siteIds: [site],
      day,
    });
    const html = renderToStaticMarkup(
      createElement(TextsScreen, {
        tab: "for-you",
        rows: conversationRows(texts, queue),
        thread: threadView({
          selected,
          thread: { source: "scenario", bubbles: [] },
          proposal: queue[0],
          day,
          assistantReachable: true,
          mayApprove: true,
        }),
        proposals: queue,
        alerts: [],
        alertsUnreadable: false,
        assistantReachable: true,
        context: null,
        editingId: request.approvalId,
        threadOpen: false,
        decide: async (): Promise<DecisionState> => ({ status: "idle" }),
        takeAlert: async () => {},
        showForYouTab: true,
      }),
    );
    // The box holds the reply's own words — not the "PPEC:" prefix, which the reply rule refuses.
    expect(html).toMatch(/<textarea[^>]*name="edited"/);
    expect(html).toContain(`>${REPLY}</textarea>`);
    expect(html).toContain('value="APPROVED"');
    expect(html).toContain(`>${approval.editCancel}</a>`);
    // And the family still has not been told anything.
    expect(html).toContain(approval.nothingUntilApproved);
    // The edit itself queued nothing: the decision model was never called.
    expect(decideApproval).not.toHaveBeenCalled();
  });
});

/**
 * One exported function's body, as text: from its `export … function <name>` line to the next
 * one (or the end of the file). Enough to tell two actions in one module apart, which is all
 * the assertion above needs.
 */
function bodyOf(source: string, name: string): string {
  const start = source.search(new RegExp(`^export (?:async )?function ${name}\\b`, "m"));
  expect(start, `${name} is not an exported function of this module`).toBeGreaterThanOrEqual(0);
  // To the closing brace in column 0, which is where a top-level function ends in this codebase.
  const rest = source.slice(start);
  const end = rest.search(/^\}/m);
  expect(end, `${name} has no closing brace in column 0`).toBeGreaterThan(0);
  return rest.slice(0, end + 1);
}
