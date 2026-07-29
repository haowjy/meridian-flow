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
import { createHoverIntent, type HoverIntent, type HoverIntentOptions } from "./hover-intent";
import { assertKeymapContribution, type KeymapContribution } from "./keymap";

export type ChromeLayerOptions = {
  /** Stable within one open; used in traces and by the Esc chain. */
  id: string;
  /**
   * Dismiss this layer. The Esc chain calls it for the topmost layer; a
   * Radix-backed surface points it at its own `onOpenChange(false)` so the
   * library keeps owning the animation and focus return.
   */
  close: () => void;
};

export type ChromeLayerHandle = {
  readonly id: string;
  /** Leave the chain without dismissing: the surface already closed itself. */
  release: () => void;
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
  /** Open transient layers in open order; the last is topmost. */
  readonly layers: readonly ChromeLayer[];
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
  /** Dismiss the topmost layer. True when there was one. */
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
   * Hover intent that the kernel cancels when a gesture starts. Approach
   * chrome should always take its timing from here rather than its own
   * `setTimeout`, or it will linger through a drag.
   */
  createHoverIntent: <T>(options: HoverIntentOptions<T>) => HoverIntent<T>;
};

/** What `ChromeKernelExtension` drives. Surfaces never see this half. */
export type EditorChromeController = {
  setContext: (context: ChromeContext) => void;
  setGesture: (phase: GesturePhase) => void;
  /** Esc's first step: tell the drag's owner to give up, then stop suppressing. */
  cancelGesture: () => void;
  destroy: () => void;
};

let chromeSequence = 0;

export function createEditorChrome(): {
  chrome: EditorChrome;
  controller: EditorChromeController;
} {
  chromeSequence += 1;
  const id = `editor-chrome-${chromeSequence}`;
  const listeners = new Set<() => void>();
  const claims: ContextClaimHandler[] = [];
  const keymaps: KeymapContribution[] = [];
  const hoverIntents = new Set<HoverIntent<unknown>>();
  const layerCloses = new Map<string, () => void>();

  let layers: ChromeLayer[] = [];
  let gesture: GesturePhase = "idle";
  let context: ChromeContext = DOCUMENT_CHROME_CONTEXT;
  /** The drag that is actually running, if any. Identity, not a flag. */
  let activeDrag: { token: symbol; cancel?: () => void } | null = null;
  let keymapRevision = 0;

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
    get gesture() {
      return gesture;
    },
    get suppressed() {
      return gesture !== "idle";
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    openLayer({ id, close }) {
      // One id, one open layer: a surface that re-registers without releasing
      // would leave a ghost step in the walk home.
      const key = layerCloses.has(id) ? `${id}#${layers.length}` : id;
      layerCloses.set(key, close);
      layers = [...layers, { id: key }];
      notify();

      return {
        id: key,
        release() {
          if (!layerCloses.delete(key)) return;
          layers = layers.filter((layer) => layer.id !== key);
          notify();
        },
      };
    },

    closeTopLayer() {
      const topmost = layers[layers.length - 1];
      if (!topmost) return false;
      const close = layerCloses.get(topmost.id);
      // The surface's own dismissal releases the handle, which is what removes
      // it from the chain — closing here and popping here would race it.
      close?.();
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

    createHoverIntent(options) {
      const intent = createHoverIntent(options);
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
    },
  };

  function abandonActiveDrag(): void {
    const drag = activeDrag;
    activeDrag = null;
    drag?.cancel?.();
  }

  const controller: EditorChromeController = {
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
      for (const intent of hoverIntents) intent.dispose();
      hoverIntents.clear();
      listeners.clear();
      claims.length = 0;
      keymaps.length = 0;
      layerCloses.clear();
      layers = [];
    },
  };

  return { chrome, controller };
}
