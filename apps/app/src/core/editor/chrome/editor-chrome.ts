/**
 * The chrome kernel's runtime: one small store per editor holding what every
 * surface has to agree on — which layers are open, what the pointer is doing,
 * which context owns chrome, and who claims a right-click.
 *
 * Headless and editor-free on purpose. It holds no `Editor`, dispatches no
 * transaction, and touches no DOM; `ChromeKernelExtension` is the one thing
 * that reads this store and acts on the document. That split is what lets the
 * walk-home policy, the claim table, and suppression be tested as data.
 *
 * Surface exclusivity is NOT here. Radix already makes menus, popovers, and
 * dialogs mutually exclusive layers, and hover rows are approach chrome rather
 * than active surfaces (decision 2026-07-29). A surface registers with
 * `openLayer` so the Esc chain knows about it; it does not ask permission to
 * exist.
 */

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

/** Who takes Escape for a layer when the editor does not have focus. */
export type ChromeLayerDismissal =
  /** The surface has its own Escape listener — every Radix layer does. */
  | "self"
  /** Nothing else is listening, so the kernel must. The safe default. */
  | "kernel";

export type ChromeLayerOptions = {
  /** Unique while open; used in traces and by the Esc chain. */
  id: string;
  /**
   * The layer this one opened INSIDE, when there is one.
   *
   * Depth cannot be inferred from registration order: React mounts child
   * effects before parent effects, so a dialog that opens with its source pane
   * already open registers the pane first. Reading the list as a stack would
   * make the dialog topmost and spend both steps of the walk home on one key —
   * and that is the design's mandated new-empty-diagram path, not an edge case.
   */
  parentId?: string | null;
  /**
   * Dismiss this layer. The Esc chain calls it for the topmost layer; a
   * Radix-backed surface points it at its own `onOpenChange(false)` so the
   * library keeps owning the animation and focus return.
   */
  close: () => void;
  dismissal?: ChromeLayerDismissal;
};

export type ChromeLayerHandle = {
  readonly id: string;
  /** Leave the chain without dismissing: the surface already closed itself. */
  release: () => void;
};

type ChromeLayerRecord = {
  id: string;
  parentId: string | null;
  dismissal: ChromeLayerDismissal;
  /** Asked to close and hasn't released yet: out of the walk, still on screen. */
  closing: boolean;
  sequence: number;
  close: () => void;
};

export type EditorChrome = {
  /**
   * Identifies this editor's chrome. Two documents open side by side are two
   * kernels listening on the same page, so chrome portalled out of the editor
   * has to say whose it is or both would route a right-click on it.
   */
  readonly id: string;
  /** Deepest context under the selection, recomputed per transaction. */
  readonly context: ChromeContext;
  /**
   * Open transient layers, shallowest first, so the last is topmost. Ordered
   * by nesting depth rather than by when each registered, and a layer that has
   * been asked to close is already out of the list.
   */
  readonly layers: readonly ChromeLayer[];
  /** How the topmost layer expects Escape to reach it. Null when none is open. */
  readonly topLayerDismissal: ChromeLayerDismissal | null;
  readonly gesture: GesturePhase;
  /**
   * A drag or sweep is in flight, so active surfaces stand down (BlockNote's
   * rule, §3). Everything re-evaluates on release rather than reappearing
   * where it was: the document moved under it.
   */
  readonly suppressed: boolean;
  /** Fires on every change above. React reads it with `useSyncExternalStore`. */
  subscribe: (listener: () => void) => () => void;

  openLayer: (layer: ChromeLayerOptions) => ChromeLayerHandle;
  /**
   * Ask the topmost layer to dismiss. True when there was one to ask.
   *
   * Asking is once. A layer whose close does not land — a surface whose owner
   * unmounted mid-animation, a dismissal that threw — leaves the walk on the
   * asking, so the next Escape steps past it. "Nobody is ever trapped" outranks
   * the tidier property of never over-stepping a surface that is still fading.
   */
  closeTopLayer: () => boolean;

  /** Take right-clicks at a rung of the claim ladder. Returns an unregister. */
  registerContextClaim: (handler: ContextClaimHandler) => () => void;
  claimHandlers: () => readonly ContextClaimHandler[];

  /** Contribute keys at a named scope. Returns an unregister. */
  registerKeymap: (contribution: KeymapContribution) => () => void;
  keymapContributions: () => readonly KeymapContribution[];
  /** Bumps whenever the contribution set changes, so callers can cache a merge. */
  readonly keymapRevision: number;

  /**
   * A surface-owned drag (block handle, column resize). Returns its end.
   * `onCancel` is how Esc reaches a drag the kernel did not start (§5.8):
   * without it the kernel could only stop suppressing, leaving a drop line
   * chasing a pointer nobody is listening to.
   */
  beginDrag: (onCancel?: () => void) => () => void;

  /**
   * Take part in the approach (`hover-anchor.ts`). ONE block owns hover chrome
   * at a time and this lane is told its share of it, including after a scroll
   * the writer's hand did not follow. A lane that answers "what am I hovering"
   * from its own listener will disagree with the others eventually, and two
   * disagreeing answers are two chromes on screen for two different blocks.
   *
   * This is the only door to hover here on purpose: a surface with its own
   * intent has its own pointer, and that is the whole defect class.
   */
  registerHoverAnchor: <T>(lane: HoverAnchorLane<T>) => () => void;

  /**
   * The writer's last input device was a finger or a pen. A tap has no
   * approach to settle, so the lanes that can follow the selection instead do
   * (§5.8, law 8) — and a hybrid machine answers for the hand actually on it
   * rather than for a media query.
   */
  readonly coarsePointer: boolean;
};

/** What `ChromeKernelExtension` drives. Surfaces never see this half. */
export type EditorChromeController = {
  /**
   * The approach's DOM half: where the pointer is, and when to ask again.
   * `ChromeKernelExtension` is the only thing that drives it.
   */
  hoverAnchors: HoverAnchors;
  setCoarsePointer: (coarse: boolean) => void;
  setContext: (context: ChromeContext) => void;
  setGesture: (phase: GesturePhase) => void;
  /** Esc's first step: tell the drag's owner to give up, then stop suppressing. */
  cancelGesture: () => void;
  destroy: () => void;
};

let chromeSequence = 0;

export function createEditorChrome(
  /** The approach's clock. Injected so the timing policy is testable. */
  hoverTimers?: HoverIntentTimers,
): {
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

  let layerSequence = 0;
  let layers: ChromeLayer[] = [];
  let gesture: GesturePhase = "idle";
  let context: ChromeContext = DOCUMENT_CHROME_CONTEXT;
  /** The drag that is actually running, if any. Identity, not a flag. */
  let activeDrag: { token: symbol; cancel?: () => void } | null = null;
  let keymapRevision = 0;
  let coarsePointer = false;

  /**
   * Hover intent the kernel can reach: a gesture cancels every one of them, so
   * approach chrome cannot linger through a drag. The coordinator's own intent
   * is one of these, which is why a drag clears the whole approach at once.
   */
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

    openLayer({ id, parentId = null, close, dismissal = "kernel" }) {
      // Law 4: one transient surface. A surface summoned at the top level
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
      layerRecords.set(key, {
        id: key,
        parentId,
        dismissal,
        closing: false,
        sequence: layerSequence,
        close,
      });
      reorderLayers();

      return {
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
      // as it was and the next lane's registration still lands.
      assertKeymapContribution(contribution);
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

  /**
   * Active layers, shallowest first. Depth is the parent chain, so a child
   * registered before its parent still sorts after it; siblings fall back to
   * the order they opened in.
   */
  function reorderLayers(): void {
    const active = [...layerRecords.values()].filter((record) => !record.closing);
    const depths = new Map<string, number>();
    const depthOf = (record: ChromeLayerRecord): number => {
      const cached = depths.get(record.id);
      if (cached !== undefined) return cached;
      const parent = record.parentId ? layerRecords.get(record.parentId) : undefined;
      // Guard the cycle a mis-registered parent could make, and treat a parent
      // that already closed as no parent at all.
      depths.set(record.id, 0);
      const depth = parent && !parent.closing ? depthOf(parent) + 1 : 0;
      depths.set(record.id, depth);
      return depth;
    };

    active.sort((a, b) => depthOf(a) - depthOf(b) || a.sequence - b.sequence);
    layers = active.map((record) => ({ id: record.id }));
    notify();
  }

  /**
   * Ask every open top-level surface to close, and take its subtree out of the
   * walk with it. Marked before the call, like `closeTopLayer`, so a surface
   * whose dismissal never lands cannot keep the chain pointed at it.
   */
  function replaceOpenTransients(): void {
    const roots = [...layerRecords.values()].filter(
      (record) => record.parentId === null && !record.closing,
    );
    if (roots.length === 0) return;

    const replaced = new Set(roots.map((record) => record.id));
    for (const record of layerRecords.values()) {
      if (record.parentId !== null && replaced.has(record.parentId)) replaced.add(record.id);
    }
    for (const record of layerRecords.values()) {
      if (replaced.has(record.id)) record.closing = true;
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
      layerRecords.clear();
      layers = [];
    },
  };

  return { chrome, controller };
}
