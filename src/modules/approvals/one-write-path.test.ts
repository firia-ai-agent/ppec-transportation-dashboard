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
 *
 * ## What PPE-97 added, and why it does not weaken either gate
 *
 * The Edit state also holds the **reply itself** as a field now (founder, 2026-10-18: the
 * coordinator can edit the whole draft, and Approve sends exactly the edited text). That field is
 * inside the form that approves, so it is not a third write path and not a second press: the words
 * and the decision arrive in the same POST, to the same action, which still calls `decideApproval`
 * and nothing else. The shape check those words are held to — the one the model's own reply passed
 * — runs inside that function (`modules/approvals/edited-reply.test.ts`).
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
import type { DecisionState, RedraftState } from "@/app/(app)/family-texts/actions";

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

describe("gate 2: an edited message needs a fresh approval", () => {
  const day = demoDay();
  const request = demoChangeRequests(day)[0];

  /**
   * An Edit *navigation* moves the time the proposal records, and the body it re-renders is still
   * the template's.
   *
   * It used to move both — `dropoff.changed` said "at 5:30 PM", so a re-render showed the edit in
   * the sentence. The COPY RULE took the clock out of that body (Vera's S1-2 item b), so moving
   * the time moves a field and a recorded value and not a word of copy, which is what this holds.
   *
   * What it no longer claims is that a person's keystrokes cannot reach a family's phone at all.
   * Since PPE-97 there is exactly one route by which they can — the staff-approval path, the
   * reply field on this card, submitted with the decision and held to `replyTextIssue`
   * server-side — which is §11.2's rule read as written: free text to parents *without human
   * approval* is what is banned. Every automatic send is still a fixed template with code-shaped
   * vars (`free-text-egress.test.ts`).
   */
  it("moves the time and not the words: the reply is the template's, before and after", () => {
    const edited = withRequestedTime(request, "17:30", day);
    expect(edited.requestedHhmm).toBe("17:30");
    expect(edited.timeTo).toBe("5:30 PM");
    expect(request.requestedHhmm).not.toBe("17:30");
    // The sentence is unchanged, because it names no minute to change (COPY RULE).
    expect(edited.draftText).toBe(request.draftText);
    expect(edited.draftText).not.toMatch(/\d{1,2}:\d{2}/);
    // Same template, so the words are still the outbox's and not a person's.
    expect(edited.templateId).toBe(request.templateId);
  });

  it("sends nothing: Edit is a GET navigation, not the decision", () => {
    const card = readFileSync(CARD_FILE, "utf8");
    // The Edit control's form posts nowhere: it is a `GET` to this screen.
    expect(card).toMatch(/<form method="get" action=\{editHref\}/);
    /*
     * Every form that reaches the server action, taken one at a time.
     *
     * Asserted per form rather than over the tail of the file because the row is now three
     * controls in the mockup's order — Approve & send, Edit, Don't send (mockups/approvals.html
     * `.acts`; Firia, 2026-10-17 10:51 PM ET) — so the Edit navigation sits *between* the two
     * posting forms. What gate 1 claims is that no posting form carries Edit, and this is that
     * claim rather than a claim about where Edit appears in the source.
     *
     * Three of them since PPE-97: the two above, plus the form the Edit state renders instead,
     * which carries the reply field and both decision buttons. It posts to the same `submit` and
     * carries no Edit control either, which is the whole of what is asserted here.
     */
    const posted = [...card.matchAll(/<form action=\{submit\}([\s\S]*?)<\/form>/g)].map((m) => m[1]);
    expect(posted).toHaveLength(3);
    // The Edit control's own label, as the card renders it (`{approval.edit}`) — spelled with the
    // braces so it is not matched by `approval.editTextLabel`, the label on the reply field, which
    // IS inside a posting form and is the point of PPE-97.
    for (const form of posted) expect(form).not.toContain("{approval.edit}");
    /*
     * The two decisions are in those forms, by the names the card gives them: since PPE-97 the
     * buttons are two one-line components, because the card posts the decision from two places
     * (the action row, and the Edit state's one form) and a second copy of a submit button is a
     * second place for its `value` to be wrong. The words are still `copy.ts`'s, which is the half
     * that matters here, so both halves are read.
     */
    expect(posted.join("")).toContain("<ApproveButton");
    expect(posted.join("")).toContain("<DontSendButton");
    expect(card).toMatch(/function ApproveButton[\s\S]*?approval\.approveAndSend/);
    expect(card).toMatch(/function DontSendButton[\s\S]*?approval\.dontSend/);
    // And each one carries the decision it stands for, which is what the action reads.
    expect(card).toMatch(/function ApproveButton[\s\S]*?value="APPROVED"/);
    expect(card).toMatch(/function DontSendButton[\s\S]*?value="DECLINED"/);
  });

  it("comes back pending, with Approve still to press", async () => {
    const { TextsScreen } = await import("@/app/(app)/family-texts/TextsScreen");
    const { conversationRows, threadView } = await import(
      "@/app/(app)/family-texts/conversations"
    );
    const { approvalQueue } = await import("@/app/(app)/family-texts/queue");
    const { DROPOFF_CHANGE_KIND } = await import("@/modules/agent/run/exec/proposals");
    const { childTokenOf } = await import("@/modules/demo/fixtures/standard");
    const texts = demoLateDropoffs(day);
    const selected = texts[texts.length - 1];
    const edited = withRequestedTime(request, "17:30", day);
    /*
     * The card comes from a real approval row and the Edit time is applied over it by the queue
     * (S1-2: the fixture card is gone). `editedTime` is the only thing that moves — the row still
     * says 17:00 — which is exactly the claim: an edit changes the words on screen and writes
     * nothing, so what is rendered is still a PENDING proposal.
     */
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
        template_id: request.templateId,
        vars: request.vars,
      },
    };
    const queue = await approvalQueue({
      db: { query: async () => ({ rows: [row] as never[] }) },
      siteIds: [site],
      day,
      editedTime: "17:30",
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
        editing: false,
        editedTime: "17:30",
        threadOpen: false,
        decide: async (): Promise<DecisionState> => ({ status: "idle" }),
        redraft: async (): Promise<RedraftState> => ({ status: "idle" }),
        takeAlert: async () => {},
        showForYouTab: true,
      }),
    );
    /*
     * The new time is what Approve would carry, and the card is in its edit state around it.
     *
     * Not "5:30 PM" any more: Vera's card has no Time row (7:51 AM ET) and no clock time
     * anywhere on it, and `dropoff.changed` places no hour in the words either — so the edited
     * time lives on the decision the three buttons post, which is what this reads.
     */
    expect(html).toContain('value="17:30"');
    expect(html).toContain(approval.edit);
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
