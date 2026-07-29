/**
 * ChromeKernelExtension — the one place the chrome kernel touches the editor.
 *
 * It creates the per-editor `EditorChrome` store, keeps its resolved context
 * current, routes `contextmenu` through the claim table, watches the pointer
 * for sweeps, runs registered keymap contributions, and performs the Esc chain.
 * Everything it decides is decided by the pure modules beside it; this file
 * only reads the document and dispatches.
 *
 * Priority 1050: above every ordinary extension, below
 * `UndoRedoKeymapExtension` at 1100. Undo is the writer's recovery over LLM
 * writes (ruling 17) and nothing here may shadow it.
 *
 * Access it with `getEditorChrome(editor)`; the extension's own name is the
 * storage key.
 */

import { type Editor, Extension } from "@tiptap/core";
import { keydownHandler } from "@tiptap/pm/keymap";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import {
  caretHomeFromObjectTransaction,
  selectObjectTransaction,
} from "../objects/object-selection";
import { chromeContextAt, resolveChromeContext } from "./chrome-context";
import { type ContextClaimTarget, resolveContextClaim } from "./context-claims";
import {
  createEditorChrome,
  type EditorChrome,
  type EditorChromeController,
} from "./editor-chrome";
import { escStep } from "./esc-chain";
import { type KeymapBinding, mergeKeymapContributions } from "./keymap";

const CHROME_EXTENSION_NAME = "meridianChrome";

export const chromeKernelPluginKey = new PluginKey("meridianChromeKernel");

type ChromeStorage = {
  chrome: EditorChrome;
  /** @internal driven by this extension only. */
  controller: EditorChromeController;
};

declare module "@tiptap/core" {
  interface Storage {
    meridianChrome: ChromeStorage;
  }
}

/**
 * The kernel for this editor, or null on an editor that never mounted it
 * (standalone code surfaces). Surfaces must handle null rather than assume:
 * an editor without chrome is a real state, not a bug.
 */
export function getEditorChrome(editor: Editor | null | undefined): EditorChrome | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[CHROME_EXTENSION_NAME]?.chrome ?? null;
}

/** Pointer travel that turns a click into a sweep, matching ProseMirror's slop. */
const SWEEP_SLOP_PX = 4;

/**
 * Marks chrome that lives outside the editor's DOM — a portalled object row, a
 * table grip — as still belonging to the editor, so a right-click on it goes
 * through the claim ladder instead of straight to the browser.
 */
export const EDITOR_CHROME_ATTRIBUTE = "data-editor-chrome";

export const ChromeKernelExtension = Extension.create({
  name: CHROME_EXTENSION_NAME,
  priority: 1050,

  addStorage(): ChromeStorage {
    return createEditorChrome();
  },

  onDestroy() {
    this.storage.controller.destroy();
  },

  addProseMirrorPlugins() {
    const { chrome, controller } = this.storage;

    // Rebuilt only when a surface registers or unregisters, so an ordinary
    // keystroke costs one map lookup rather than a merge of every lane's keys.
    let cachedBindings: Record<string, KeymapBinding> = {};
    let cachedRevision = -1;
    const bindingsFor = () => {
      if (cachedRevision !== chrome.keymapRevision) {
        cachedRevision = chrome.keymapRevision;
        cachedBindings = mergeKeymapContributions(chrome.keymapContributions());
      }
      return cachedBindings;
    };

    let sweepOrigin: { x: number; y: number } | null = null;

    return [
      new Plugin({
        key: chromeKernelPluginKey,

        view(view) {
          controller.setContext(resolveChromeContext(view.state));

          // The pointer leaves the editor mid-sweep constantly (a selection
          // dragged past the last paragraph), so release is watched on the
          // window rather than the editor DOM.
          const endSweep = () => {
            sweepOrigin = null;
            if (chrome.gesture === "sweep") controller.setGesture("idle");
          };
          window.addEventListener("mouseup", endSweep);

          // Chrome that portals out of the editor still routes through the
          // ladder. Without this a right-click on an object's own row would
          // reach the browser instead of the object's menu, which is the one
          // place the split matrix would read as an accident.
          const routeChromeMenu = (event: MouseEvent) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (view.dom.contains(target)) return;
            if (!target.closest(`[${EDITOR_CHROME_ATTRIBUTE}]`)) return;
            routeContextMenu(view, chrome, event);
          };
          document.addEventListener("contextmenu", routeChromeMenu, true);

          return {
            update(updatedView, previousState) {
              if (
                updatedView.state.doc === previousState.doc &&
                updatedView.state.selection.eq(previousState.selection)
              ) {
                return;
              }
              controller.setContext(resolveChromeContext(updatedView.state));
            },
            destroy() {
              window.removeEventListener("mouseup", endSweep);
              document.removeEventListener("contextmenu", routeChromeMenu, true);
            },
          };
        },

        props: {
          handleKeyDown(view, event) {
            if (event.key === "Escape") return performEscStep(view, chrome, controller);
            return keydownHandler(bindingsFor())(view, event);
          },

          handleDOMEvents: {
            mousedown(_view, event) {
              if (event.button === 0) sweepOrigin = { x: event.clientX, y: event.clientY };
              return false;
            },
            mousemove(_view, event) {
              if (!sweepOrigin || chrome.gesture !== "idle") return false;
              const travelled =
                Math.abs(event.clientX - sweepOrigin.x) + Math.abs(event.clientY - sweepOrigin.y);
              if (travelled >= SWEEP_SLOP_PX) controller.setGesture("sweep");
              return false;
            },
            contextmenu(view, event) {
              return routeContextMenu(view, chrome, event);
            },
          },
        },
      }),
    ];
  },
});

/**
 * The claim decision, synchronous inside the event because `preventDefault`
 * is worthless after it returns. Nobody claiming is the common case and the
 * designed one: the browser keeps its menu, and spellcheck with it (ruling 11).
 */
function routeContextMenu(view: EditorView, chrome: EditorChrome, event: MouseEvent): boolean {
  const element = event.target;
  if (!(element instanceof HTMLElement)) return false;

  const coords = { left: event.clientX, top: event.clientY };
  const docPos = view.posAtCoords(coords)?.pos ?? null;
  const { selection } = view.state;

  const target: ContextClaimTarget = {
    element,
    docPos,
    context:
      docPos === null ? resolveChromeContext(view.state) : chromeContextAt(view.state.doc, docPos),
    insideTextSelection:
      !selection.empty && docPos !== null && docPos >= selection.from && docPos <= selection.to,
    event,
  };

  if (!resolveContextClaim(chrome.claimHandlers(), target)) return false;
  event.preventDefault();
  return true;
}

function performEscStep(
  view: EditorView,
  chrome: EditorChrome,
  controller: EditorChromeController,
): boolean {
  const step = escStep({ gesture: chrome.gesture, layers: chrome.layers, context: chrome.context });

  switch (step.kind) {
    case "cancel-gesture":
      controller.cancelGesture();
      return true;

    case "close-layer":
      return chrome.closeTopLayer();

    case "select-object": {
      const transaction = selectObjectTransaction(view.state, step.pos);
      if (!transaction) return false;
      view.dispatch(transaction);
      view.focus();
      return true;
    }

    case "caret-after-block": {
      const transaction = caretHomeFromObjectTransaction(view.state, step.pos);
      if (!transaction) return false;
      view.dispatch(transaction);
      view.focus();
      return true;
    }

    case "at-home":
      // Home is not "handled". Leaving the key alone is what lets a browser
      // dialog, an IME composition, or a native affordance still see it.
      return false;
  }
}
