/**
 * One owner, and a hit test that survives a world moving under a still hand.
 *
 * These are the three invariants the human's fast-scroll report named: chrome
 * never claims a target the pointer has left, a scroll re-asks the question
 * rather than only re-measuring the answer, and two different targets are never
 * claimed at once.
 */

import { describe, expect, it } from "vitest";

import { createHoverAnchors, type HoverProbe } from "./hover-anchor";
import { createHoverIntent, type HoverIntentOptions } from "./hover-intent";

/** Settles the instant a target arrives, so the tests read as pointer moves. */
function immediate<T>(options: HoverIntentOptions<T>) {
  return createHoverIntent({
    ...options,
    timers: {
      setTimeout: (handler) => {
        handler();
        return 0;
      },
      clearTimeout: () => {},
    },
  });
}

const BLOCK_A = { name: "a" };
const BLOCK_B = { name: "b" };

/** The page: which block each y falls in, and what element sits there. */
function pageOf(rows: Record<number, { owner: object; element: string } | undefined>) {
  return (x: number, y: number): HoverProbe | null => {
    const row = rows[y];
    if (!row) return null;
    return { x, y, element: { tagName: row.element } as unknown as Element, onChrome: false };
  };
}

describe("hover anchors", () => {
  it("gives two lanes on one block their share, and drops both when the pointer leaves", () => {
    const anchors = createHoverAnchors(immediate);
    const grip: (object | null)[] = [];
    const chips: (object | null)[] = [];

    anchors.observe(pageOf({ 10: { owner: BLOCK_A, element: "IMG" } }));
    anchors.register({
      id: "grip",
      probe: (at) => (at.y === 10 ? { owner: BLOCK_A, value: BLOCK_A } : null),
      onSettle: (value) => grip.push(value),
    });
    anchors.register({
      id: "chips",
      probe: (at) => (at.y === 10 ? { owner: BLOCK_A, value: BLOCK_A } : null),
      onSettle: (value) => chips.push(value),
    });

    anchors.pointerAt(0, 10);
    expect(grip.at(-1)).toBe(BLOCK_A);
    expect(chips.at(-1)).toBe(BLOCK_A);

    anchors.pointerGone();
    expect(grip.at(-1)).toBeNull();
    expect(chips.at(-1)).toBeNull();
  });

  it("never leaves two lanes claiming two different blocks", () => {
    const anchors = createHoverAnchors(immediate);
    let grip: object | null = null;
    let chips: object | null = null;

    // The chip lane answers for block A wherever the pointer is — the stale
    // per-lane state machine the fast-scroll screenshot caught. The
    // coordinator is what stops it from being on screen beside another block.
    anchors.observe(
      pageOf({ 10: { owner: BLOCK_A, element: "IMG" }, 90: { owner: BLOCK_B, element: "P" } }),
    );
    anchors.register({
      id: "grip",
      probe: (at) =>
        at.y === 10 ? { owner: BLOCK_A, value: "a" } : { owner: BLOCK_B, value: "b" },
      onSettle: (value) => {
        grip = value as object | null;
      },
    });
    anchors.register({
      id: "chips",
      probe: () => ({ owner: BLOCK_A, value: "chips" }),
      onSettle: (value) => {
        chips = value as object | null;
      },
    });

    anchors.pointerAt(0, 90);
    expect(grip).toBe("b");
    expect(chips).toBeNull();
  });

  it("re-targets when a different block slides under a pointer that never moved", () => {
    const anchors = createHoverAnchors(immediate);
    const settled: (string | null)[] = [];
    let ownerUnderPointer = BLOCK_A;

    anchors.observe((x, y) => ({
      x,
      y,
      element: {} as Element,
      onChrome: false,
    }));
    anchors.register({
      id: "grip",
      probe: () => ({ owner: ownerUnderPointer, value: ownerUnderPointer === BLOCK_A ? "a" : "b" }),
      onSettle: (value) => settled.push(value as string | null),
    });

    anchors.pointerAt(0, 10);
    expect(settled.at(-1)).toBe("a");

    // The pane scrolls. No pointer event, no transaction: another block is
    // simply where the last one was.
    ownerUnderPointer = BLOCK_B;
    anchors.remeasure();

    expect(anchors.owner).toBe(BLOCK_B);
    expect(settled.at(-1)).toBe("b");
  });

  it("keeps the owner while the pointer rests on the chrome it revealed", () => {
    const anchors = createHoverAnchors(immediate);
    let settled: string | null = null;

    let onChrome = false;
    anchors.observe((x, y) => ({ x, y, element: {} as Element, onChrome }));
    anchors.register({
      id: "grip",
      probe: (at) => (at.onChrome ? null : { owner: BLOCK_A, value: "a" }),
      onSettle: (value) => {
        settled = value as string | null;
      },
    });

    anchors.pointerAt(0, 10);
    expect(settled).toBe("a");

    // The pointer travels onto the grip, which is portalled out of the prose:
    // the hit test under it answers for whatever the control covers, and the
    // reveal must survive the trip it invited.
    onChrome = true;
    anchors.pointerAt(0, 10);
    expect(settled).toBe("a");
  });

  it("keeps a lane's target across the gap its own control is drawn in", () => {
    const anchors = createHoverAnchors(immediate);
    let grips: string | null = null;

    // A table's grips live outside the frame; the pixels between are on no
    // cell and on no chrome, and they belong to the reveal.
    anchors.observe((x, y) => ({ x, y, element: {} as Element, onChrome: false }));
    anchors.register({
      id: "block",
      probe: () => ({ owner: BLOCK_A, value: "block" }),
      onSettle: () => {},
    });
    anchors.register({
      id: "table",
      probe: (at) => (at.x < 100 ? { owner: BLOCK_A, value: "cell" } : null),
      holds: (_value, at) => at.x < 130,
      onSettle: (value) => {
        grips = value as string | null;
      },
    });

    anchors.pointerAt(0, 10);
    expect(grips).toBe("cell");

    anchors.pointerAt(120, 10);
    expect(grips).toBe("cell");

    anchors.pointerAt(200, 10);
    expect(grips).toBeNull();
  });

  it("forgets the pointer when the reading says the page is not this editor's", () => {
    const anchors = createHoverAnchors(immediate);
    let settled: string | null = null;

    let inside = true;
    anchors.observe((x, y) => (inside ? { x, y, element: {} as Element, onChrome: false } : null));
    anchors.register({
      id: "grip",
      probe: () => ({ owner: BLOCK_A, value: "a" }),
      onSettle: (value) => {
        settled = value as string | null;
      },
    });

    anchors.pointerAt(0, 10);
    expect(settled).toBe("a");

    inside = false;
    anchors.remeasure();
    expect(settled).toBeNull();
  });
});
