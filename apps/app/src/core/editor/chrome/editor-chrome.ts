import { type ChromeContext, DOCUMENT_CHROME_CONTEXT } from "./chrome-context";
import type { ContextClaimHandler } from "./context-claims";
import type { ChromeLayer, GesturePhase } from "./esc-chain";
import { createHoverAnchors, type HoverAnchorLane, type HoverAnchors } from "./hover-anchor";
import {
  createHoverIntent,
  type HoverIntent,
  type HoverIntentOptions,
  type HoverIntentTimers,
} from "./hover-intent";
import { assertKeymapContribution, type KeymapContribution } from "./keymap";

export type ChromeLayerDismissal = "self" | "kernel";

export type ChromeLayerOptions = {
  id: string;
  ownerId?: string;
  parentId?: string | null;
  close: () => void;
  dismissal?: ChromeLayerDismissal;
};

export type ChromeLayerHandle = {
  readonly layer: ChromeLayer;
  readonly id: string;
  release: () => void;
};

type ChromeLayerRecord = {
  layer: ChromeLayer;
  parentId: string | null;
  dismissal: ChromeLayerDismissal;
  closing: boolean;
  sequence: number;
  close: () => void;
};

export type ChromeLayerRetreat = {
  ownerId: string;
  backtrack: () => boolean;
  dismiss: () => void;
};

export type EditorChrome = {
  readonly id: string;
  readonly context: ChromeContext;
  readonly layers: readonly ChromeLayer[];
  readonly topLayerDismissal: ChromeLayerDismissal | null;
  readonly gesture: GesturePhase;
  readonly suppressed: boolean;
  subscribe: (listener: () => void) => () => void;

  openLayer: (layer: ChromeLayerOptions) => ChromeLayerHandle;
  closeTopLayer: () => boolean;
  retreatTopLayer: () => boolean;
  registerLayerRetreat: (retreat: ChromeLayerRetreat) => () => void;

  registerContextClaim: (handler: ContextClaimHandler) => () => void;
  claimHandlers: () => readonly ContextClaimHandler[];

  registerKeymap: (contribution: KeymapContribution) => () => void;
  keymapContributions: () => readonly KeymapContribution[];
  readonly keymapRevision: number;

  beginDrag: (onCancel?: () => void) => () => void;

  registerHoverAnchor: <T>(lane: HoverAnchorLane<T>) => () => void;

  readonly coarsePointer: boolean;
};

export type EditorChromeController = {
  hoverAnchors: HoverAnchors;
  setCoarsePointer: (coarse: boolean) => void;
  setContext: (context: ChromeContext) => void;
  setGesture: (phase: GesturePhase) => void;
  cancelGesture: () => void;
  destroy: () => void;
};

let chromeSequence = 0;

export function createEditorChrome(hoverTimers?: HoverIntentTimers): {
  chrome: EditorChrome;
  controller: EditorChromeController;
} {
  chromeSequence += 1;
  const id = `editor-chrome-${chromeSequence}`;
  const listeners = new Set<() => void>();
  const claims: ContextClaimHandler[] = [];
  const keymaps: KeymapContribution[] = [];
  const hoverIntents = new Set<HoverIntent<unknown>>();
  const layerRecords = new Map<string, ChromeLayerRecord>();
  const layerRetreats: ChromeLayerRetreat[] = [];

  let layerSequence = 0;
  let layers: ChromeLayer[] = [];
  let gesture: GesturePhase = "idle";
  let context: ChromeContext = DOCUMENT_CHROME_CONTEXT;
  let activeDrag: { token: symbol; cancel?: () => void } | null = null;
  let keymapRevision = 0;
  let coarsePointer = false;

  const trackHoverIntent = <T>(options: HoverIntentOptions<T>): HoverIntent<T> => {
    const intent = createHoverIntent({ timers: hoverTimers, ...options });
    hoverIntents.add(intent as HoverIntent<unknown>);
    return {
      ...intent,
      get settled() {
        return intent.settled;
      },
      dispose() {
        hoverIntents.delete(intent as HoverIntent<unknown>);
        intent.dispose();
      },
    };
  };

  const hoverAnchors = createHoverAnchors(trackHoverIntent);

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setGesture = (phase: GesturePhase) => {
    if (gesture === phase) return;
    gesture = phase;
    // Approach chrome goes away for the whole gesture, not just where the
    // pointer is now: a drag that started under a hovered object leaves it
    // behind immediately.
    if (phase !== "idle") for (const intent of hoverIntents) intent.cancel();
    notify();
  };

  const chrome: EditorChrome = {
    id,
    get context() {
      return context;
    },
    get layers() {
      return layers;
    },
    get topLayerDismissal() {
      return topRecord()?.dismissal ?? null;
    },
    get gesture() {
      return gesture;
    },
    get suppressed() {
      return gesture !== "idle";
    },
    get coarsePointer() {
      return coarsePointer;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    openLayer({ id, ownerId = id, parentId = null, close, dismissal = "kernel" }) {
      //: one transient surface. A surface summoned at the top level
      // REPLACES whatever was there — the slash menu and the link form both
      // staying live left two inputs competing for the same keystrokes. A
      // layer opened inside another (a submenu, a dialog's source pane) is
      // not a rival; it is part of the surface that is already open, which is
      // exactly what `parentId` distinguishes.
      if (parentId === null) replaceOpenTransients();

      // One id, one open layer: a surface that re-registers without releasing
      // would leave a ghost step in the walk home.
      const key = layerRecords.has(id) ? `${id}#${layerSequence}` : id;
      layerSequence += 1;
      const layer: ChromeLayer = { id: key, ownerId };
      layerRecords.set(key, {
        layer,
        parentId,
        dismissal,
        closing: false,
        sequence: layerSequence,
        close,
      });
      reorderLayers();

      return {
        layer,
        id: key,
        release() {
          if (!layerRecords.delete(key)) return;
          reorderLayers();
        },
      };
    },

    closeTopLayer() {
      const topmost = topRecord();
      if (!topmost) return false;
      // Marked before the call, so a close that never releases costs one
      // Escape rather than every Escape after it.
      topmost.closing = true;
      reorderLayers();
      topmost.close();
      return true;
    },

    retreatTopLayer() {
      const topmost = topRecord();
      const retreat = topmost
        ? [...layerRetreats].reverse().find((entry) => entry.ownerId === topmost.layer.ownerId)
        : layerRetreats.at(-1);
      if (!retreat) return false;
      if (retreat.backtrack()) return true;
      // With a real layer, its existing close path owns Radix animation and
      // focus return. Before React registers that layer, the semantic lease is
      // the only owner available and closes the suggestion directly.
      if (topmost) return false;
      retreat.dismiss();
      return true;
    },

    registerLayerRetreat(retreat) {
      layerRetreats.push(retreat);
      return () => {
        const index = layerRetreats.indexOf(retreat);
        if (index >= 0) layerRetreats.splice(index, 1);
      };
    },

    registerContextClaim(handler) {
      claims.push(handler);
      return () => {
        const index = claims.indexOf(handler);
        if (index >= 0) claims.splice(index, 1);
      };
    },
    claimHandlers: () => claims,

    registerKeymap(contribution) {
      // Before the push, so a refused contribution leaves the registry exactly
      // as it was and the next lane's registration still lands. The registry
      // goes in with it: a collision is a question about what is already
      // registered, and this is the last moment the stack still names the lane
      // that wrote the binding.
      assertKeymapContribution(contribution, keymaps);
      keymaps.push(contribution);
      keymapRevision += 1;
      notify();
      return () => {
        const index = keymaps.indexOf(contribution);
        if (index < 0) return;
        keymaps.splice(index, 1);
        keymapRevision += 1;
        notify();
      };
    },
    keymapContributions: () => keymaps,
    get keymapRevision() {
      return keymapRevision;
    },

    beginDrag(onCancel) {
      // A second drag while one is running means the first is over, whatever
      // its owner still thinks: two owners cannot both hold the pointer. Tell
      // the older one so it stops drawing a drop line nobody is aiming.
      abandonActiveDrag();

      const token = Symbol("drag");
      activeDrag = { token, cancel: onCancel };
      setGesture("drag");

      return () => {
        // A late end from a drag that was already replaced is not this
        // gesture's to release. Without the token it would unsuppress the
        // drag the writer is actually running.
        if (activeDrag?.token !== token) return;
        activeDrag = null;
        setGesture("idle");
      };
    },

    registerHoverAnchor: (lane) => hoverAnchors.register(lane),
  };

  function reorderLayers(): void {
    const active = [...layerRecords.values()].filter((record) => !record.closing);
    const depths = new Map<string, number>();
    const depthOf = (record: ChromeLayerRecord): number => {
      const cached = depths.get(record.layer.id);
      if (cached !== undefined) return cached;
      const parent = record.parentId ? layerRecords.get(record.parentId) : undefined;
      // Guard the cycle a mis-registered parent could make, and treat a parent
      // that already closed as no parent at all.
      depths.set(record.layer.id, 0);
      const depth = parent && !parent.closing ? depthOf(parent) + 1 : 0;
      depths.set(record.layer.id, depth);
      return depth;
    };

    active.sort((a, b) => depthOf(a) - depthOf(b) || a.sequence - b.sequence);
    // The records' own tokens, not copies of them: a surface's keys name the
    // token it was handed, and the merge finds it here by identity.
    layers = active.map((record) => record.layer);
    notify();
  }

  function replaceOpenTransients(): void {
    const roots = [...layerRecords.values()].filter(
      (record) => record.parentId === null && !record.closing,
    );
    if (roots.length === 0) return;

    const replaced = new Set(roots.map((record) => record.layer.id));
    for (const record of layerRecords.values()) {
      if (record.parentId !== null && replaced.has(record.parentId)) replaced.add(record.layer.id);
    }
    for (const record of layerRecords.values()) {
      if (replaced.has(record.layer.id)) record.closing = true;
    }
    reorderLayers();

    for (const root of roots) root.close();
  }

  function topRecord(): ChromeLayerRecord | null {
    const topmost = layers[layers.length - 1];
    return topmost ? (layerRecords.get(topmost.id) ?? null) : null;
  }

  function abandonActiveDrag(): void {
    const drag = activeDrag;
    activeDrag = null;
    drag?.cancel?.();
  }

  const controller: EditorChromeController = {
    hoverAnchors,
    setCoarsePointer(coarse) {
      if (coarsePointer === coarse) return;
      coarsePointer = coarse;
      notify();
    },
    setContext(next) {
      if (
        next.owner === context.owner &&
        next.nodeType === context.nodeType &&
        next.objectSpec === context.objectSpec &&
        next.pos === context.pos
      ) {
        return;
      }
      context = next;
      notify();
    },
    setGesture,
    cancelGesture() {
      abandonActiveDrag();
      setGesture("idle");
    },
    destroy() {
      activeDrag = null;
      hoverAnchors.dispose();
      for (const intent of hoverIntents) intent.dispose();
      hoverIntents.clear();
      listeners.clear();
      claims.length = 0;
      keymaps.length = 0;
      layerRetreats.length = 0;
      layerRecords.clear();
      layers = [];
    },
  };

  return { chrome, controller };
}
