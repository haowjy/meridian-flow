/**
 * Who owns hover chrome, and what is under the pointer after the world moved.
 *
 * `createHoverIntent` answers when to believe a pointer. It never answers the
 * harder question — what is under that pointer NOW — and every lane that
 * revealed something on approach ended up answering it alone, from its own
 * listener, in its own state machine. Three independent answers is how a
 * chip cluster claimed one object while a grip claimed another block on the
 * same screen, and how chrome stayed up for a target the writer had scrolled
 * away from without moving their hand.
 *
 * So the question is asked once, here:
 *
 * - The pointer's last place is remembered, and re-read whenever the
 *   manuscript moves under it. Scroll and reflow are pointer events with no
 *   pointer event: the hand is still and the target under it is not.
 * - Exactly one **owner** is hovered at a time. An owner is a top-level block
 *   element (`hoverOwner`), so a diagram's chips and its block's grip settle
 *   on the same owner and compose, while two different blocks cannot both be
 *   claimed because there is one owner to be.
 * - A lane says what it found and drops it when it is no longer the owner's.
 *
 * Deliberately narrow. It knows nothing about menus, selection, or where a
 * piece of chrome is drawn: selection-persistent chrome (a selected table's ⋮,
 * a caret inside a fence) is a different mode and stays its lane's own.
 *
 * Headless apart from one reading of the page, which the caller supplies
 * (`observe`): the kernel extension owns the DOM, this owns the policy.
 */

import type { EditorView } from "@tiptap/pm/view";

import type { HoverIntent, HoverIntentOptions } from "./hover-intent";

/** The page at a point, as the kernel extension reads it. */
export type HoverProbe = {
  /** Viewport coordinates, remembered so a still pointer can be re-read. */
  x: number;
  y: number;
  /** Topmost element there. */
  element: Element;
  /**
   * That element is this editor's own chrome. Travelling onto a revealed
   * control is not a step off the target it belongs to, and the hit test
   * under it would answer for whatever the control covers.
   */
  onChrome: boolean;
};

/** How a point becomes a reading. Null means "not this editor's business". */
export type HoverProbeResolver = (x: number, y: number) => HoverProbe | null;

export type HoverAnchorLane<T> = {
  /** Names the lane in probes and traces. */
  id: string;
  /** What this lane decorates at the pointer, and which block owns it. */
  probe: (at: HoverProbe) => { owner: object; value: T } | null;
  /**
   * The pointer is still on this lane's own reveal even though the probe
   * missed — the pixels BETWEEN a table's frame and the grip drawn beside it
   * belong to the reveal, and they are not on any cell.
   */
  holds?: (value: T, at: HoverProbe) => boolean;
  /**
   * The lane hit something fresh while still holding something else — two
   * subtargets of ONE owner, which happens when targets nest. A table in a
   * table's cell shares its top-level block with it, and the gap beside the
   * inner frame hit-tests to the outer cell, so a fresh hit there is not a
   * move: only the lane can tell an ancestor conceding the approach from the
   * pointer genuinely arriving somewhere new. It answers which value the
   * reveal follows. Absent, the fresh hit wins.
   */
  reconcile?: (held: T, hit: T, at: HoverProbe) => T;
  /** This lane's share of the settled owner, or null once it has none. */
  onSettle: (value: T | null) => void;
};

export type HoverAnchors = {
  /** Take part in the approach. Returns an unregister. */
  register: <T>(lane: HoverAnchorLane<T>) => () => void;
  /** Install the page reading. Returns a teardown. */
  observe: (resolve: HoverProbeResolver) => () => void;
  /** The pointer is at these viewport coordinates. */
  pointerAt: (x: number, y: number) => void;
  /** The pointer is gone: off this editor, off the page, or not a mouse. */
  pointerGone: () => void;
  /** The manuscript moved under a pointer that did not. */
  remeasure: () => void;
  /** The block owning hover chrome right now, or null when nothing is. */
  readonly owner: object | null;
  dispose: () => void;
};

/**
 * The owner key: the top-level block element containing `element`.
 *
 * Every lane resolves its owner through this one function, which is what makes
 * "one owner at a time" mean the same thing to all of them. A block is the
 * right grain because it is the unit the writer sees: an image's chips and its
 * paragraph's grip decorate one thing and belong on screen together, while a
 * cell's grips and another paragraph's handle never do.
 */
export function hoverOwner(view: EditorView, element: Element | null): HTMLElement | null {
  if (!element || !view.dom.contains(element)) return null;
  let current: Element | null = element;
  while (current && current.parentElement !== view.dom) current = current.parentElement;
  return current instanceof HTMLElement ? current : null;
}

type AnyLane = HoverAnchorLane<unknown>;

export function createHoverAnchors(
  createIntent: <T>(options: HoverIntentOptions<T>) => HoverIntent<T>,
): HoverAnchors {
  const lanes = new Set<AnyLane>();
  /** Each lane's share of the current owner. Absent means "nothing here". */
  const values = new Map<AnyLane, unknown>();
  let resolve: HoverProbeResolver | null = null;
  let at: HoverProbe | null = null;
  let owner: object | null = null;

  const intent = createIntent<object>({
    onSettle: (settled) => {
      owner = settled;
      deliver();
    },
  });

  function deliver(): void {
    for (const lane of lanes) {
      lane.onSettle(owner === null ? null : (values.get(lane) ?? null));
    }
  }

  /** The pointer left every target but is still on something a lane revealed. */
  function heldByChrome(probe: HoverProbe): boolean {
    for (const lane of lanes) {
      const value = values.get(lane);
      if (value !== undefined && lane.holds?.(value, probe)) return true;
    }
    return false;
  }

  function pass(): void {
    const probe = at;
    if (!probe) {
      values.clear();
      intent.leave();
      return;
    }

    // On a revealed control: keep whoever it belongs to, and cancel any grace
    // the trip off the target started. Re-entering rather than merely not
    // leaving is the load-bearing half — a grace left running fires on a
    // pointer already resting on the control and fades it out from under them.
    if (probe.onChrome) {
      if (owner !== null) intent.enter(owner);
      return;
    }

    const hits = new Map<AnyLane, unknown>();
    let found: object | null = null;
    for (const lane of lanes) {
      const hit = lane.probe(probe);
      if (!hit) continue;
      // First hit names the owner. Lanes cannot really disagree — they all
      // resolve through `hoverOwner`, and one point is inside one block — but
      // if one ever did, the answer is still ONE owner rather than two.
      found ??= hit.owner;
      if (hit.owner === found) hits.set(lane, hit.value);
    }

    if (found === null) {
      if (owner !== null && heldByChrome(probe)) {
        intent.enter(owner);
        return;
      }
      values.clear();
      intent.leave();
      return;
    }

    // A lane whose reveal still holds the pointer keeps its target even though
    // the point itself is off it: the gap beside a table's frame is where the
    // writer travels to reach the grip drawn there. And a lane that freshly
    // HIT while holding may have hit the outer half of a nested pair — that
    // same gap, beside an inner table, is on the outer table's cell — so which
    // of the two the reveal follows is the lane's call (`reconcile`).
    if (found === owner) {
      for (const lane of lanes) {
        const held = values.get(lane);
        if (held === undefined) continue;
        if (!hits.has(lane)) {
          if (lane.holds?.(held, probe)) hits.set(lane, held);
        } else if (lane.reconcile) {
          hits.set(lane, lane.reconcile(held, hits.get(lane), probe));
        }
      }
    }

    const sameOwner = found === owner;
    values.clear();
    for (const [lane, value] of hits) values.set(lane, value);
    intent.enter(found);
    // The intent says nothing when the owner has not changed, and a lane still
    // has to hear that the pointer moved to another cell of the same table.
    if (sameOwner) deliver();
  }

  return {
    register(lane) {
      const erased = lane as AnyLane;
      lanes.add(erased);
      return () => {
        lanes.delete(erased);
        values.delete(erased);
      };
    },

    observe(next) {
      resolve = next;
      return () => {
        if (resolve !== next) return;
        resolve = null;
        at = null;
      };
    },

    pointerAt(x, y) {
      at = resolve?.(x, y) ?? null;
      pass();
    },

    pointerGone() {
      at = null;
      pass();
    },

    remeasure() {
      if (!at) return;
      at = resolve?.(at.x, at.y) ?? null;
      pass();
    },

    get owner() {
      return owner;
    },

    dispose() {
      intent.dispose();
      lanes.clear();
      values.clear();
      resolve = null;
      at = null;
      owner = null;
    },
  };
}
