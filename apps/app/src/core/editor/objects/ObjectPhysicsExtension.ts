import { type Editor, Extension, isMacOS } from "@tiptap/core";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { isRemoteDocumentRebuild } from "../anchors";
import { getEditorChrome } from "../chrome/ChromeKernelExtension";
import { selectedSourceBlock } from "../chrome/chrome-context";
import type { KeymapBinding } from "../chrome/keymap";
import {
  caretBesideObjectTransaction,
  caretInsideObjectTransaction,
  deleteObjectTransaction,
  documentEndTransaction,
  documentStartTransaction,
  enterCellTransaction,
  type ObjectAt,
  objectBeside,
  objectSelectionForDOM,
  objectTextSelectionTransaction,
  selectedObject,
  selectObjectTransaction,
  typeBesideObjectTransaction,
  verticalStepFrom,
} from "./object-selection";
import { EDITOR_OBJECT_TYPES, isEditorObject, objectBody, objectTypeSpec } from "./object-types";
import { pictureCapped } from "./picture-cap";

const OBJECT_PHYSICS_NAME = "meridianObjectPhysics";

export const objectPhysicsPluginKey = new PluginKey(OBJECT_PHYSICS_NAME);

export const SELECTED_OBJECT_CLASS = "meridian-object-selected";

export function objectSelectedInDecorations(decorations: readonly { spec?: unknown }[]): boolean {
  return decorations.some(
    (decoration) => (decoration.spec as { selectedObject?: unknown } | undefined)?.selectedObject,
  );
}

export type ObjectOpening = "engage" | "created";

export type ObjectEngagement = (target: ObjectAt, opening: ObjectOpening) => void;

type ObjectPhysicsStorage = {
  engagements: Map<string, ObjectEngagement>;
};

declare module "@tiptap/core" {
  interface Storage {
    meridianObjectPhysics: ObjectPhysicsStorage;
  }
}

function physicsStorage(editor: Editor): ObjectPhysicsStorage | null {
  if (editor.isDestroyed) return null;
  return editor.storage[OBJECT_PHYSICS_NAME] ?? null;
}

export function registerObjectEngagement(
  editor: Editor,
  specId: string,
  engagement: ObjectEngagement,
): () => void {
  const storage = physicsStorage(editor);
  if (!storage) return () => {};
  storage.engagements.set(specId, engagement);
  return () => {
    if (storage.engagements.get(specId) === engagement) storage.engagements.delete(specId);
  };
}

export function engageObject(editor: Editor, target: ObjectAt, opening: ObjectOpening): boolean {
  const storage = physicsStorage(editor);
  const spec = objectTypeSpec(target.node);
  if (!storage || spec?.engage !== "surface") return false;
  const engagement = storage.engagements.get(spec.id);
  if (!engagement) return false;
  engagement(target, opening);
  return true;
}

export function registerObjectKeymap(
  editor: Editor,
  specId: string,
  bindings: Readonly<Record<string, KeymapBinding>>,
): () => void {
  const chrome = getEditorChrome(editor);
  if (!chrome) return () => {};

  return chrome.registerKeymap({
    id: `object:${specId}`,
    scope: "object",
    appliesTo: (context) => context.objectSpec === specId,
    bindings,
  });
}

function objectAtDOM(view: EditorView, element: Element): ObjectAt | null {
  let pos: number;
  try {
    pos = view.posAtDOM(element, 0);
  } catch {
    return null;
  }
  if (pos < 0 || pos > view.state.doc.content.size) return null;

  const $pos = view.state.doc.resolve(pos);
  const after = $pos.nodeAfter;
  if (after && isEditorObject(after)) return { node: after, pos: $pos.pos };

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (isEditorObject(node)) return { node, pos: $pos.before(depth) };
  }
  return null;
}

function selectObjectUnderPress(view: EditorView, event: MouseEvent): void {
  // The primary button only: a right-click belongs to the context-claim
  // ladder, and the browser's own default is how it gets there.
  if (event.button !== 0 || event.defaultPrevented || !view.editable) return;

  const target = event.target;
  if (!(target instanceof Element)) return;
  const opaque = target.closest('[contenteditable="false"]');
  if (!opaque || !view.dom.contains(opaque)) return;

  const found = objectAtDOM(view, opaque);
  if (!found) return;
  if (objectBody(found.node) === "inline-drag") return;
  const transaction = selectObjectTransaction(view.state, found.pos);
  if (!transaction) return;

  // Refusing the default IS the fix: the hunt for an editable position is the
  // browser's default action, and nothing later can take a caret back.
  event.preventDefault();
  view.dispatch(transaction);
  // The refused default would have focused the editor, and every object key
  // and the Esc chain need it focused all the same.
  view.focus();
}

export const ObjectPhysicsExtension = Extension.create({
  name: OBJECT_PHYSICS_NAME,
  // Under the chrome kernel (1050) and undo (1100): object physics is the
  // deepest thing in the document, never the outermost thing on screen.
  priority: 1040,

  addStorage(): ObjectPhysicsStorage {
    return { engagements: new Map() };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const { engagements } = this.storage;

    return [
      new Plugin({
        key: objectPhysicsPluginKey,

        /**
         * A rebuild restores a node selection by position alone, so when the
         * selected object goes (undo, a peer, an AI write) it lands on whatever
         * followed, and the next keystroke would replace that text.
         */
        appendTransaction(transactions, oldState, newState) {
          const before = oldState.selection;
          const after = newState.selection;
          if (!(before instanceof NodeSelection) || !(after instanceof NodeSelection)) return null;
          if (after.node.type === before.node.type) return null;
          if (!transactions.some(isRemoteDocumentRebuild)) return null;
          return newState.tr.setSelection(TextSelection.near(after.$from));
        },

        /** Registration rides the view's lifetime rather than TipTap's `create` event, which is emitted a macrotask late — long enough for a first keystroke to miss it. */
        view(editorView) {
          const chrome = getEditorChrome(editor);
          // Walking ONTO an object starts from prose beside
          // it, so the arrows cannot be scoped to "an object is selected" —
          // they are block-level movement that declines wherever there is no
          // object to step on. Enter genuinely needs the selection.
          const releases = [
            chrome?.registerKeymap({
              id: "object-extend-selection",
              scope: "object",
              appliesTo: (context) =>
                EDITOR_OBJECT_TYPES.some(
                  (spec) => spec.id === context.objectSpec && spec.body === "inline-drag",
                ),
              bindings: objectSelectionExtensionBindings(),
            }),
            chrome?.registerKeymap({
              id: "object-native-extend-selection",
              scope: "object",
              route: "native",
              appliesTo: (context) =>
                EDITOR_OBJECT_TYPES.some(
                  (spec) => spec.id === context.objectSpec && spec.body === "text",
                ),
              bindings: objectSelectionExtensionBindings(),
            }),
            chrome?.registerKeymap({
              id: "object-walk",
              scope: "block",
              bindings: {
                ArrowRight: (state, dispatch) => walk(state, dispatch, 1),
                ArrowDown: (state, dispatch, view) => walk(state, dispatch, 1, view),
                ArrowLeft: (state, dispatch) => walk(state, dispatch, -1),
                ArrowUp: (state, dispatch, view) => walk(state, dispatch, -1, view),
              },
            }),
            chrome?.registerKeymap({
              id: "object-document-edges",
              scope: "document",
              bindings: {
                "Mod-Home": toDocumentStart,
                "Mod-End": toDocumentEnd,
                ...(isMacOS()
                  ? { "Mod-ArrowUp": toDocumentStart, "Mod-ArrowDown": toDocumentEnd }
                  : {}),
              },
            }),
            chrome?.registerKeymap({
              id: "object-remove",
              scope: "object",
              bindings: { Delete: removeSelected, Backspace: removeSelected },
            }),
            chrome?.registerKeymap({
              id: "object-engage",
              // Not `object` scope:'s Enter row covers a selected plain
              // fence too, and a plain fence is not an object. The binding
              // still declines anything that is not a whole block selection,
              // which hands the key back for ordinary typing.
              scope: "block",
              appliesTo: (context) =>
                context.owner === "object" || context.owner === "source-block",
              bindings: { Enter: (state, dispatch) => engage(editor, state, dispatch) },
            }),
          ];

          const onMouseDown = (event: MouseEvent) => selectObjectUnderPress(editorView, event);
          editorView.dom.addEventListener("mousedown", onMouseDown);

          return {
            destroy() {
              editorView.dom.removeEventListener("mousedown", onMouseDown);
              for (const release of releases) release?.();
              engagements.clear();
            },
          };
        },

        props: {
          decorations(state) {
            const range = selectedObjectRange(state);
            if (!range) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(
                range.from,
                range.to,
                { class: SELECTED_OBJECT_CLASS },
                { selectedObject: true },
              ),
            ]);
          },

          // Chromium adopts a nonempty native range before compositionstart.
          // Keep object selection in the model, but give native input a caret.
          selectionForDOM: (view) => (view.editable ? objectSelectionForDOM(view.state) : null),

          handleTextInput(view, _from, _to, text) {
            const selected = selectedObject(view.state);
            if (!selected) return false;
            const transaction = typeBesideObjectTransaction(view.state, selected.pos);
            if (!transaction) return false;
            view.dispatch(transaction.insertText(text));
            return true;
          },

          handleClickOn(view, _pos, node, nodePos, event, direct) {
            if (!direct || !isEditorObject(node)) return false;
            const transaction = selectObjectTransaction(view.state, nodePos);
            if (!transaction) return false;
            view.dispatch(transaction);
            view.focus();
            // Selected first, as for a double-click: closing the surface lands here.
            if (objectTypeSpec(node)?.clickEngages?.(event.target)) {
              engage(editor, view.state, view.dispatch.bind(view));
            }
            return true;
          },

          handleDOMEvents: {
            mousedown(view, event) {
              if (!view.editable || !event.shiftKey || event.button !== 0 || event.defaultPrevented)
                return false;
              if (!selectedObject(view.state)?.node.isInline) return false;
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at) return false;
              const transaction = objectTextSelectionTransaction(
                view.state,
                at.pos < view.state.selection.from ? -1 : 1,
              );
              // Run before PM starts delaying native selection updates for a drag.
              if (transaction) view.dispatch(transaction);
              return false;
            },

            beforeinput(view, event) {
              if (
                !view.editable ||
                !event.cancelable ||
                event.inputType !== "insertText" ||
                event.data === null ||
                event.isComposing ||
                view.composing ||
                /[\r\n]/.test(event.data) ||
                view.state.selection instanceof TextSelection
              )
                return false;

              // Native text input can have no keypress, which is where PM normally
              // routes a non-text selection through the text-input handlers. Left to
              // the browser, the text goes to its own caret, which for a gap cursor
              // a click made is still inside the table above it.
              const { from, to } = view.state.selection;
              const text = event.data;
              const insert = () => view.state.tr.insertText(text).scrollIntoView();
              if (
                !view.someProp("handleTextInput", (handler) =>
                  handler(view, from, to, text, insert),
                )
              )
                view.dispatch(insert());
              event.preventDefault();
              return true;
            },

            compositionstart(view) {
              if (!view.editable) return false;
              const selected = selectedObject(view.state);
              if (!selected) return false;
              // PM's compositionstart deletes a selected block (or a table's cells).
              // Establish the typing destination before it runs, not at beforeinput.
              const transaction = typeBesideObjectTransaction(view.state, selected.pos);
              if (transaction) view.dispatch(transaction);
              return false;
            },

            mouseover(_view, event) {
              if (event.target instanceof HTMLImageElement) {
                event.target.style.cursor = pictureCapped(event.target) ? "zoom-in" : "";
              }
              return false;
            },
          },

          handleDoubleClickOn(view, _pos, node, nodePos, _event, direct) {
            if (!direct || !isEditorObject(node)) return false;
            const selected = selectObjectTransaction(view.state, nodePos);
            if (!selected) return false;
            // Select first: engaging leaves the object selected underneath, so
            // closing its surface lands on the object rather than past it.
            view.dispatch(selected);
            return engage(editor, view.state, view.dispatch.bind(view));
          },
        },
      }),
    ];
  },
});

function engageSourceBlock(
  state: Parameters<KeymapBinding>[0],
  dispatch: Parameters<KeymapBinding>[1],
): boolean {
  const fence = selectedSourceBlock(state);
  if (!fence) return false;

  const inside = TextSelection.near(state.doc.resolve(fence.pos + 1), 1);
  dispatch?.(state.tr.setSelection(inside).scrollIntoView());
  return true;
}

function reportMissingEngagement(specId: string): void {
  if (!import.meta.env?.DEV || warnedMissingEngagement.has(specId)) return;
  warnedMissingEngagement.add(specId);
  console.warn(
    `[editor] "${specId}" is registered with engage: "surface", but no lane called registerObjectEngagement — Enter on it does nothing.`,
  );
}

function selectedObjectRange(
  state: Parameters<KeymapBinding>[0],
): { from: number; to: number } | null {
  const object = selectedObject(state);
  if (object) return { from: object.pos, to: object.pos + object.node.nodeSize };
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  return { from: selection.from, to: selection.to };
}

function objectSelectionExtensionBindings(): Record<string, KeymapBinding> {
  const mac = isMacOS();
  const nativeSelectionKeys = {
    ArrowLeft: -1,
    ArrowUp: -1,
    Home: -1,
    PageUp: -1,
    ArrowRight: 1,
    ArrowDown: 1,
    End: 1,
    PageDown: 1,
  } satisfies Record<string, 1 | -1>;
  const bindings = Object.fromEntries(
    (mac ? ["", "Mod-", "Alt-", "Ctrl-"] : ["", "Mod-"]).flatMap((modifier) =>
      Object.entries(nativeSelectionKeys)
        .filter(([key]) => modifier === "" || (key !== "PageUp" && key !== "PageDown"))
        .map(([key, direction]) => [
          `${modifier}Shift-${key}`,
          prepareObjectSelectionExtension(direction),
        ]),
    ),
  );
  if (mac) {
    // macOS text controls also expose Emacs-style selection gestures.
    for (const [key, direction] of Object.entries({
      a: -1,
      b: -1,
      p: -1,
      e: 1,
      f: 1,
      n: 1,
    } satisfies Record<string, 1 | -1>)) {
      bindings[`Ctrl-Shift-${key}`] = prepareObjectSelectionExtension(direction);
    }
  }
  return bindings;
}

function prepareObjectSelectionExtension(direction: 1 | -1): KeymapBinding {
  return (state, dispatch) => {
    const transaction = objectTextSelectionTransaction(state, direction);
    if (transaction) dispatch?.(transaction);
    // The browser extends this model range, not the native typing caret.
    return false;
  };
}

const removeSelected: KeymapBinding = (state, dispatch) => {
  const selected = selectedObject(state);
  if (!selected) return false;
  return dispatchIfAny(deleteObjectTransaction(state, selected.pos), dispatch);
};

const toDocumentStart: KeymapBinding = (state, dispatch) =>
  dispatchIfAny(documentStartTransaction(state), dispatch);
const toDocumentEnd: KeymapBinding = (state, dispatch) =>
  dispatchIfAny(documentEndTransaction(state), dispatch);

function dispatchIfAny(
  transaction: Transaction | null,
  dispatch: Parameters<KeymapBinding>[1],
): boolean {
  if (!transaction) return false;
  dispatch?.(transaction);
  return true;
}

function walk(
  state: Parameters<KeymapBinding>[0],
  dispatch: Parameters<KeymapBinding>[1],
  direction: 1 | -1,
  lines?: EditorView,
): boolean {
  const selected = selectedObject(state);
  if (selected) {
    const step = lines ? verticalStepFrom(state, selected, direction) : { beside: selected };
    if ("into" in step) {
      return dispatchIfAny(enterCellTransaction(state, step.into, direction), dispatch);
    }
    const { beside } = step;
    const endsDocument =
      direction === 1 && beside.pos + beside.node.nodeSize === state.doc.content.size;
    return dispatchIfAny(
      endsDocument
        ? documentEndTransaction(state)
        : caretBesideObjectTransaction(state, beside.pos, direction),
      dispatch,
    );
  }

  const inText = state.selection.$head.parent.isTextblock;
  const beside = objectBeside(
    state,
    direction,
    lines && {
      atEdge: inText ? lines.endOfTextblock(direction === 1 ? "down" : "up", state) : undefined,
    },
  );
  if (!beside) return false;
  return dispatchIfAny(selectObjectTransaction(state, beside.pos), dispatch);
}

const warnedMissingEngagement = new Set<string>();

function engage(
  editor: Editor,
  state: Parameters<KeymapBinding>[0],
  dispatch: Parameters<KeymapBinding>[1],
): boolean {
  const selected = selectedObject(state);
  if (!selected) return engageSourceBlock(state, dispatch);

  const spec = objectTypeSpec(selected.node);
  if (!spec) return false;

  if (spec.engage === "surface") {
    if (!engageObject(editor, selected, "engage")) reportMissingEngagement(spec.id);
    return true;
  }

  if (spec.engage === "caret-inside") {
    const transaction = caretInsideObjectTransaction(state, selected.pos);
    if (transaction) dispatch?.(transaction);
  }

  return true;
}
