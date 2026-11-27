import type { EditorView } from "@tiptap/pm/view";

import type { HoverIntent, HoverIntentOptions } from "./hover-intent";

export type HoverProbe = {
  x: number;
  y: number;
  element: Element;
  /**
   * That element is this editor's own chrome. Travelling onto a revealed
   * control is not a step off the target it belongs to, and the hit test
   * under it would answer for whatever the control covers.
   */
  onChrome: boolean;
};

export type HoverProbeResolver = (x: number, y: number) => HoverProbe | null;

export type HoverAnchorLane<T> = {
  id: string;
  probe: (at: HoverProbe) => { owner: object; value: T } | null;
  holds?: (value: T, at: HoverProbe) => boolean;
  reconcile?: (held: T, hit: T, at: HoverProbe) => T;
  onSettle: (value: T | null) => void;
};

export type HoverAnchors = {
  register: <T>(lane: HoverAnchorLane<T>) => () => void;
  observe: (resolve: HoverProbeResolver) => () => void;
  pointerAt: (x: number, y: number) => void;
  pointerGone: () => void;
  remeasure: () => void;
  readonly owner: object | null;
  dispose: () => void;
};

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
