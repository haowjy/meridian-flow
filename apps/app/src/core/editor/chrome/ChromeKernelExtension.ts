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
import { chromeContextAt, proseSelectionCovers, resolveChromeContext } from "./chrome-context";
import { type ContextClaimTarget, resolveContextClaim } from "./context-claims";
import {
  createEditorChrome,
  type EditorChrome,
  type EditorChromeController,
} from "./editor-chrome";
import { escStep } from "./esc-chain";
import { type KeymapBinding, type KeymapReach, mergeKeymapContributions } from "./keymap";
import { watchManuscriptLayout } from "./manuscript-layout";

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
 * table grip — as still belonging to one editor, so a right-click on it goes
 * through that editor's claim ladder instead of straight to the browser.
 *
 * It carries the chrome's id rather than standing alone: two documents open
 * side by side are two kernels listening on the same page, and an unqualified
 * mark would hand one editor's overlay row to both.
 */
const EDITOR_CHROME_ATTRIBUTE = "data-editor-chrome";

/** Spread onto portalled chrome so the kernel's router can still see it. */
export function editorChromeAttributes(chrome: EditorChrome): Record<string, string> {
  return { [EDITOR_CHROME_ATTRIBUTE]: chrome.id };
}

/**
 * Is this element part of THIS editor's portalled chrome?
 *
 * The router asks it to decide whether an event outside the prose is still
 * the editor's, and a claim handler asks it to stand down over a lane's own
 * overlay. Qualified by the chrome's id both times: two documents side by
 * side are two kernels, and an unqualified mark would answer yes for both.
 */
export function isEditorChromeElement(chrome: EditorChrome, element: Element): boolean {
  return element.closest(`[${EDITOR_CHROME_ATTRIBUTE}="${chrome.id}"]`) !== null;
}

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
    const editor = this.editor;

    // Rebuilt only when a surface registers or unregisters, so an ordinary
    // keystroke costs one map lookup rather than a merge of every lane's keys.
    // Two maps, because where the key was pressed decides which contributions
    // may answer it: the prose hears every lane, focus inside a portalled layer
    // hears only the layers that said they reach that far.
    let cachedBindings: Record<KeymapReach, Record<string, KeymapBinding>> = {
      prose: {},
      chrome: {},
    };
    let cachedRevision = -1;
    const bindingsFor = (reach: KeymapReach) => {
      if (cachedRevision === chrome.keymapRevision) return cachedBindings[reach];
      // The revision advances only once the merge has produced something. A
      // throw between the two would otherwise leave a stale map cached against
      // a revision that never built it, and every later registration would be
      // dropped in silence.
      const applicability = () => ({ context: chrome.context, layerCount: chrome.layers.length });
      const merged = {
        prose: mergeKeymapContributions(chrome.keymapContributions(), applicability),
        chrome: mergeKeymapContributions(chrome.keymapContributions(), applicability, "chrome"),
      };
      cachedBindings = merged;
      cachedRevision = chrome.keymapRevision;
      return merged[reach];
    };

    let sweepOrigin: { x: number; y: number } | null = null;
    const endSweep = () => {
      sweepOrigin = null;
      if (chrome.gesture === "sweep") controller.setGesture("idle");
    };

    return [
      new Plugin({
        key: chromeKernelPluginKey,

        view(view) {
          controller.setContext(resolveChromeContext(view.state));

          // The pointer leaves the editor mid-sweep constantly (a selection
          // dragged past the last paragraph), so release is watched on the
          // window rather than the editor DOM. `blur` covers the release the
          // window never hears: a sweep that ends over a devtools panel, an
          // OS window switch, or a drag out of the tab would otherwise leave
          // every surface suppressed with nothing to un-suppress it.
          window.addEventListener("mouseup", endSweep);
          window.addEventListener("blur", endSweep);

          // ONE pointer source for every approach in this editor, and one
          // reading of the page under it. Each lane used to keep its own
          // listener and its own answer to "what is under the pointer"; three
          // answers is how a chip cluster claimed one object while a grip
          // claimed another block on the same screen.
          //
          // The reading is what a lane cannot do for itself: chrome portalled
          // out of the prose covers the manuscript, so the hit test under a
          // revealed control would answer for whatever it happens to sit on.
          const stopReading = controller.hoverAnchors.observe((x, y) => {
            const element = document.elementFromPoint(x, y);
            if (!(element instanceof Element)) return null;
            if (isEditorChromeElement(chrome, element)) return { x, y, element, onChrome: true };
            const host = view.dom.closest("[data-stable-layout-scroll]") ?? view.dom;
            return host.contains(element) ? { x, y, element, onChrome: false } : null;
          });

          const readPointer = (event: PointerEvent) => {
            // A finger does not hover. Remember the hand and let the lanes that
            // follow the selection place their chrome instead (law 8).
            const coarse = event.pointerType !== "mouse";
            controller.setCoarsePointer(coarse);
            if (coarse) {
              controller.hoverAnchors.pointerGone();
              return;
            }
            // Mid-drag or mid-sweep every surface stands down, and the approach
            // re-earns itself on release rather than reappearing where it was.
            if (chrome.suppressed) return;
            controller.hoverAnchors.pointerAt(event.clientX, event.clientY);
          };
          const forgetPointer = () => controller.hoverAnchors.pointerGone();

          document.addEventListener("pointermove", readPointer, { passive: true });
          document.addEventListener("pointerdown", readPointer, { passive: true });
          document.addEventListener("pointerleave", forgetPointer, { passive: true });

          // Scroll and reflow are pointer moves with no pointer event: the hand
          // is still and what is under it is not. Asking again is what keeps
          // chrome off a target the writer has scrolled away from.
          const stopWatchingLayout = watchManuscriptLayout(editor, [], () => {
            if (!chrome.suppressed) controller.hoverAnchors.remeasure();
          });

          // The router listens in the capture phase rather than through
          // ProseMirror's `handleDOMEvents`, because that prop cannot see a
          // right-click inside a node view at all: TipTap's `NodeView.stopEvent`
          // returns true for `contextmenu`, and ProseMirror consults it in
          // `eventBelongsToView` BEFORE running any handler. Every React node
          // view in this editor — image, figure, jsx_leaf, jsx_container — is
          // one of those, which is to say the two object types ruling 11 is
          // actually about. Capture reaches them all, current and future,
          // without a single node view having to cooperate.
          //
          // It covers chrome portalled OUT of the editor too, so an object's
          // overlay row and the object under it give the same answer.
          const routeMenu = (event: MouseEvent) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (!view.dom.contains(target) && !isEditorChromeElement(chrome, target)) return;
            routeContextMenu(view, chrome, event);
          };
          document.addEventListener("contextmenu", routeMenu, true);

          // Escape reaches the chain through ProseMirror while the writer is in
          // the prose, and through Radix while they are inside a Radix surface.
          // A layer that is neither — a hand-rolled portal, or any layer at all
          // once focus has moved to the chat composer — has nothing listening
          // for it, and "nobody is ever trapped" would quietly stop being true.
          // This is that backstop, and it defers to any layer that says it
          // dismisses itself so one key never closes two surfaces.
          // The same gap for every other key a layer owns. A dialog's content
          // is portalled out of the editor and holds focus while it is open, so
          // ProseMirror's `handleKeyDown` never sees the writer's Ctrl+Enter —
          // and a surface that answered it with a listener of its own would be
          // invisible to the kernel's bindings, its scope ladder, and the
          // collision the validator is there to catch. Only contributions that
          // declared `reach: "chrome"` run here; the target guard leaves the
          // prose's own keys to ProseMirror, which is the path they belong to.
          const layerKeys = (event: KeyboardEvent) => {
            if (event.defaultPrevented || chrome.layers.length === 0) return;
            if (event.target instanceof Node && view.dom.contains(event.target)) return;
            if (!keydownHandler(bindingsFor("chrome"))(view, event)) return;
            event.preventDefault();
          };
          document.addEventListener("keydown", layerKeys, true);

          const backstopEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (event.target instanceof Node && view.dom.contains(event.target)) return;
            if (chrome.topLayerDismissal !== "kernel") return;
            if (!chrome.closeTopLayer()) return;
            event.preventDefault();
          };
          document.addEventListener("keydown", backstopEscape, true);

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
              stopReading();
              stopWatchingLayout();
              document.removeEventListener("pointermove", readPointer);
              document.removeEventListener("pointerdown", readPointer);
              document.removeEventListener("pointerleave", forgetPointer);
              window.removeEventListener("mouseup", endSweep);
              window.removeEventListener("blur", endSweep);
              document.removeEventListener("contextmenu", routeMenu, true);
              document.removeEventListener("keydown", layerKeys, true);
              document.removeEventListener("keydown", backstopEscape, true);
            },
          };
        },

        props: {
          handleKeyDown(view, event) {
            if (event.key === "Escape") return performEscStep(view, chrome, controller);
            return keydownHandler(bindingsFor("prose"))(view, event);
          },

          handleDOMEvents: {
            /**
             * A non-primary press is the claim ladder's, and ProseMirror never
             * hears it.
             *
             * Returning true is how a plugin tells ProseMirror it handled a DOM
             * event — `runCustomHandler` runs before the built-in handler and
             * skips it — and skipping is the whole point. ProseMirror arms its
             * click machinery on ANY button (its own class is called
             * `LeftMouseDown`), and the matching release runs the full click
             * path: `handleClickOn`, then its own `selectClickedLeaf`. On a
             * right-click that release lands AFTER the ladder has already
             * opened the claimed menu, and re-selecting the node there syncs
             * the selection back into the editor, takes focus out of the menu,
             * and dismisses it. Whether the release beat the menu's first paint
             * decided whether the writer saw a menu at all: a quick right-click
             * on a diagram showed nothing, a held one worked.
             *
             * It refuses no default, so the `contextmenu` event still comes —
             * on the press where Linux and macOS raise it, and on the release
             * where Windows does. Ruling 11's native menu is untouched.
             */
            mousedown(_view, event) {
              if (event.button !== 0) return true;
              sweepOrigin = { x: event.clientX, y: event.clientY };
              return false;
            },
            mousemove(_view, event) {
              // The button came back up somewhere we never heard about. The
              // pointer itself is the truth, so believe it rather than waiting
              // for an event that is not coming.
              if (event.buttons === 0) {
                endSweep();
                return false;
              }
              if (!sweepOrigin || chrome.gesture !== "idle") return false;
              const travelled =
                Math.abs(event.clientX - sweepOrigin.x) + Math.abs(event.clientY - sweepOrigin.y);
              if (travelled >= SWEEP_SLOP_PX) controller.setGesture("sweep");
              return false;
            },
          },
        },
      }),
    ];
  },
});

/**
 * The claim decision, synchronous inside the event because `preventDefault`
 * is worthless after it returns. Nobody claiming means the browser keeps its
 * menu — Shift+right-click every time, and anywhere no lane took the rung.
 */
function routeContextMenu(view: EditorView, chrome: EditorChrome, event: MouseEvent): boolean {
  const element = event.target;
  if (!(element instanceof Element)) return false;

  const coords = { left: event.clientX, top: event.clientY };
  const docPos = view.posAtCoords(coords)?.pos ?? null;

  const target: ContextClaimTarget = {
    element,
    docPos,
    context:
      docPos === null ? resolveChromeContext(view.state) : chromeContextAt(view.state.doc, docPos),
    insideTextSelection: proseSelectionCovers(view.state, docPos),
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
