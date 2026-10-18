import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slotSnapshot, subscribeToSlot } from "./HeaderSlot";

/**
 * The header slot watcher (src/ui/HeaderSlot.tsx), on a tiny fake DOM: nodes with parents, a
 * `querySelector` for the one slot, and a MutationObserver that records what it watches.
 *
 * S1 (Firia 7:55 AM ET; Veri's gate 8:09 AM ET): Today -> menu -> Plan routes drew no toolbar,
 * because the slot was looked up once before the new header bar existed. The watcher must find a
 * bar mounted after render, then stop watching the page, re-arm only when that slot leaves the
 * document, never offer two hosts, and clean up on unmount. png/plan-board.png and
 * png/plan-board-390.png are where the toolbar it hosts is drawn; e2e/leg-toggle.spec.ts walks it.
 */

class FakeNode {
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  constructor(
    readonly name: string,
    readonly isSlot = false,
  ) {}
  append(child: FakeNode) {
    child.parentNode = this;
    this.children.push(child);
    fire(this, child);
    return child;
  }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    parent.children = parent.children.filter((c) => c !== this);
    this.parentNode = null;
    fire(parent, this);
  }
  get isConnected(): boolean {
    let node: FakeNode | null = this;
    while (node) {
      if (node === root) return true;
      node = node.parentNode;
    }
    return false;
  }
}

type Watch = { target: FakeNode; subtree: boolean; observer: FakeObserver };
let watches: Watch[] = [];
let root: FakeNode;

class FakeObserver {
  constructor(readonly callback: () => void) {}
  observe(target: FakeNode, options: { childList?: boolean; subtree?: boolean }) {
    watches.push({ target, subtree: options.subtree === true, observer: this });
  }
  disconnect() {
    watches = watches.filter((w) => w.observer !== this);
  }
}

/** A child list changed on `parent`: every observer on it, or on an ancestor with subtree. */
function fire(parent: FakeNode, _changed: FakeNode) {
  const hit = new Set<FakeObserver>();
  for (const w of watches) {
    if (w.target === parent) hit.add(w.observer);
    else if (w.subtree) {
      for (let n: FakeNode | null = parent; n; n = n.parentNode) if (n === w.target) hit.add(w.observer);
    }
  }
  for (const observer of hit) observer.callback();
}

function findSlot(node: FakeNode): FakeNode | null {
  if (node.isSlot) return node;
  for (const child of node.children) {
    const found = findSlot(child);
    if (found) return found;
  }
  return null;
}

/** The app's shape: body > shell > header > slot, and body > shell > main > board. */
function mountHeader(shell: FakeNode) {
  const header = shell.append(new FakeNode("header"));
  const slot = header.append(new FakeNode("slot", true));
  return { header, slot };
}

let body: FakeNode;
let shell: FakeNode;

beforeEach(() => {
  watches = [];
  root = new FakeNode("document");
  body = root.append(new FakeNode("body"));
  shell = body.append(new FakeNode("shell"));
  vi.stubGlobal("MutationObserver", FakeObserver);
  vi.stubGlobal("document", { body, querySelector: () => findSlot(body) });
});

afterEach(() => vi.unstubAllGlobals());

const bodySubtreeWatches = () => watches.filter((w) => w.target === body && w.subtree);

describe("HeaderSlot: a bar mounted after the screen rendered (soft navigation)", () => {
  it("finds the slot when it appears, tells React, and disconnects the page-wide observer", () => {
    const onChange = vi.fn();
    subscribeToSlot(onChange);
    expect(slotSnapshot()).toBeNull();
    expect(bodySubtreeWatches()).toHaveLength(1);

    const { slot } = mountHeader(shell);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(slotSnapshot()).toBe(slot);
    expect(bodySubtreeWatches()).toHaveLength(0);
    // Only child-list watches on the slot's own ancestors are left, none with subtree.
    expect(watches.every((w) => !w.subtree)).toBe(true);
    expect(watches.map((w) => w.target.name)).toEqual(["header", "shell", "body"]);
  });

  it("does not re-read on the board's own DOM changes once the slot is found", () => {
    const { slot } = mountHeader(shell);
    const onChange = vi.fn();
    subscribeToSlot(onChange);
    expect(bodySubtreeWatches()).toHaveLength(0);
    const main = shell.append(new FakeNode("main")); // a direct child of an ancestor: checked, slot still there
    const board = main.append(new FakeNode("board"));
    for (let i = 0; i < 20; i += 1) board.append(new FakeNode(`card-${i}`));
    slot.append(new FakeNode("toolbar")); // the portal itself
    expect(onChange).not.toHaveBeenCalled();
  });

  it("re-arms when the header remounts, and only ever offers one host (no duplicate portal)", () => {
    const first = mountHeader(shell);
    const onChange = vi.fn();
    subscribeToSlot(onChange);

    first.header.remove();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(slotSnapshot()).toBeNull();
    expect(bodySubtreeWatches()).toHaveLength(1);

    const second = mountHeader(shell);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(slotSnapshot()).toBe(second.slot);
    expect(slotSnapshot()).not.toBe(first.slot);
    expect(bodySubtreeWatches()).toHaveLength(0);
    // Exactly one slot in the document: one host, so one portal.
    const slots: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      if (n.isSlot) slots.push(n);
      n.children.forEach(walk);
    };
    walk(body);
    expect(slots).toEqual([second.slot]);
  });

  it("five round trips Today <-> Plan routes leave one watcher set, never a growing pile", () => {
    const onChange = vi.fn();
    let header = mountHeader(shell).header;
    const unsubscribe = subscribeToSlot(onChange);
    for (let i = 0; i < 5; i += 1) {
      header.remove();
      header = mountHeader(shell).header;
    }
    expect(onChange).toHaveBeenCalledTimes(10);
    expect(watches.map((w) => w.target.name)).toEqual(["header", "shell", "body"]);
    unsubscribe();
    expect(watches).toHaveLength(0);
  });

  it("cleans up on unmount, whether it was searching or watching", () => {
    const searching = subscribeToSlot(vi.fn());
    expect(watches.length).toBe(1);
    searching();
    expect(watches).toHaveLength(0);

    mountHeader(shell);
    const watching = subscribeToSlot(vi.fn());
    expect(watches.length).toBeGreaterThan(0);
    watching();
    expect(watches).toHaveLength(0);
  });
});
