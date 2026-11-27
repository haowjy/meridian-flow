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
import { type KeymapBinding, type KeymapRoute, mergeKeymapContributions } from "./keymap";
import { watchManuscriptLayout } from "./manuscript-layout";
import { pastSlop } from "./track-press";

const CHROME_EXTENSION_NAME = "meridianChrome";

export const chromeKernelPluginKey = new PluginKey("meridianChromeKernel");

type ChromeStorage = {
  chrome: EditorChrome;
  controller: EditorChromeController;
};

declare module "@tiptap/core" {
  interface Storage {
    meridianChrome: ChromeStorage;
  }
}

export function getEditorChrome(editor: Editor | null | undefined): EditorChrome | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[CHROME_EXTENSION_NAME]?.chrome ?? null;
}

const EDITOR_CHROME_ATTRIBUTE = "data-editor-chrome";

export function editorChromeAttributes(chrome: EditorChrome): Record<string, string> {
  return { [EDITOR_CHROME_ATTRIBUTE]: chrome.id };
}

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

    let cachedBindings: Record<KeymapRoute, Record<string, KeymapBinding>> = {
      prose: {},
      chrome: {},
      native: {},
    };
    let cachedRevision = -1;
    const bindingsFor = (route: KeymapRoute) => {
      if (cachedRevision === chrome.keymapRevision) return cachedBindings[route];
      // The revision advances only once the merge has produced something. A
      // throw during a merge would otherwise leave a stale map cached against
      // a revision that never built it, and every later registration would be
      // dropped in silence.
      const applicability = () => ({ context: chrome.context, layers: chrome.layers });
      const merged = {
        prose: mergeKeymapContributions(chrome.keymapContributions(), applicability),
        chrome: mergeKeymapContributions(chrome.keymapContributions(), applicability, "chrome"),
        native: mergeKeymapContributions(chrome.keymapContributions(), applicability, "native"),
      };
      cachedBindings = merged;
      cachedRevision = chrome.keymapRevision;
      return merged[route];
    };

    let leaveArmed = false;

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

          const stopReading = controller.hoverAnchors.observe((x, y) => {
            const element = document.elementFromPoint(x, y);
            if (!(element instanceof Element)) return null;
            if (isEditorChromeElement(chrome, element)) return { x, y, element, onChrome: true };
            const host = view.dom.closest("[data-stable-layout-scroll]") ?? view.dom;
            return host.contains(element) ? { x, y, element, onChrome: false } : null;
          });

          const readPointer = (event: PointerEvent) => {
            const coarse = event.pointerType !== "mouse";
            controller.setCoarsePointer(coarse);
            if (coarse) {
              controller.hoverAnchors.pointerGone();
              return;
            }
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
          // one of those, which are the two object types the
          // capture exists for. Capture reaches them all, current and future,
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

          const layerKeys = (event: KeyboardEvent) => {
            if (event.defaultPrevented || chrome.layers.length === 0) return;
            if (event.target instanceof Node && view.dom.contains(event.target)) return;
            if (!keydownHandler(bindingsFor("chrome"))(view, event)) return;
            event.preventDefault();
          };
          document.addEventListener("keydown", layerKeys, true);

          // Bubble runs after PM's plugin handlers AND captureKeyDown, before
          // browser default. Earlier preparation would bypass table movement.
          const nativeKeys = (event: KeyboardEvent) => {
            if (
              event.target !== view.dom ||
              event.defaultPrevented ||
              !view.editable ||
              view.composing ||
              event.isComposing ||
              event.keyCode === 229
            )
              return;
            keydownHandler(bindingsFor("native"))(view, event);
          };
          document.addEventListener("keydown", nativeKeys);

          const backstopEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (event.target instanceof Node && view.dom.contains(event.target)) return;
            if (!performEscStep(view, chrome, controller, "chrome")) return;
            event.preventDefault();
          };
          document.addEventListener("keydown", backstopEscape, true);

          const leaveOnTab = (event: KeyboardEvent) => {
            if (!leaveArmed || event.key === "Shift") return;
            leaveArmed = false;
            if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.target instanceof Node && view.dom.contains(event.target)) {
              event.stopPropagation();
            }
          };
          const disarmLeave = () => {
            leaveArmed = false;
          };
          document.addEventListener("keydown", leaveOnTab, true);
          view.dom.addEventListener("focusout", disarmLeave);
          view.dom.addEventListener("pointerdown", disarmLeave);

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
              document.removeEventListener("keydown", nativeKeys);
              document.removeEventListener("keydown", backstopEscape, true);
              document.removeEventListener("keydown", leaveOnTab, true);
              view.dom.removeEventListener("focusout", disarmLeave);
              view.dom.removeEventListener("pointerdown", disarmLeave);
            },
          };
        },

        props: {
          handleKeyDown(view, event) {
            if (event.key === "Escape") {
              const handled = performEscStep(view, chrome, controller, "prose");
              leaveArmed = !handled;
              return handled;
            }
            return keydownHandler(bindingsFor("prose"))(view, event);
          },

          handleDOMEvents: {
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
              if (pastSlop(event.clientX - sweepOrigin.x, event.clientY - sweepOrigin.y)) {
                controller.setGesture("sweep");
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

/** The claim decision, synchronous inside the event because `preventDefault` is worthless after it returns. */
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
  reach: "prose" | "chrome",
): boolean {
  const step = escStep({ gesture: chrome.gesture, layers: chrome.layers, context: chrome.context });
  if (reach === "chrome" && (step.kind === "select-object" || step.kind === "caret-after-block")) {
    return false;
  }

  switch (step.kind) {
    case "cancel-gesture":
      controller.cancelGesture();
      return true;

    case "close-layer":
      // A Radix layer hears Escape through its own listener, and closing it
      // here as well would spend one key on two surfaces.
      if (reach === "chrome" && chrome.topLayerDismissal !== "kernel") return false;
      if (chrome.retreatTopLayer()) return true;
      return chrome.closeTopLayer();

    case "select-object": {
      if (chrome.retreatTopLayer()) return true;
      const transaction = selectObjectTransaction(view.state, step.pos);
      if (!transaction) return false;
      view.dispatch(transaction);
      view.focus();
      return true;
    }

    case "caret-after-block": {
      if (chrome.retreatTopLayer()) return true;
      const transaction = caretHomeFromObjectTransaction(view.state, step.pos);
      if (!transaction) return false;
      view.dispatch(transaction);
      view.focus();
      return true;
    }

    case "at-home":
      return chrome.retreatTopLayer();
  }
}
