/** Coordinates selection, engagement, and key behavior for registered editor objects. */

import { type Editor, Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { getEditorChrome } from "../chrome/ChromeKernelExtension";
import { selectedSourceBlock } from "../chrome/chrome-context";
import type { KeymapBinding } from "../chrome/keymap";
import {
  caretBesideObjectTransaction,
  caretInsideObjectTransaction,
  deleteObjectTransaction,
  type ObjectAt,
  objectBeside,
  selectedObject,
  selectObjectTransaction,
  typeBesideObjectTransaction,
} from "./object-selection";
import { isEditorObject, objectBody, objectTypeSpec } from "./object-types";

const OBJECT_PHYSICS_NAME = "meridianObjectPhysics";

export const objectPhysicsPluginKey = new PluginKey(OBJECT_PHYSICS_NAME);

/** The class the jade ring paints on. */
export const SELECTED_OBJECT_CLASS = "meridian-object-selected";

/** The same fact in the same decoration, for a node view that has to DO something about being selected rather than only look different — an image's resize handles, which exist while the jade ring does and not otherwise. */
export function objectSelectedInDecorations(decorations: readonly { spec?: unknown }[]): boolean {
  return decorations.some(
    (decoration) => (decoration.spec as { selectedObject?: unknown } | undefined)?.selectedObject,
  );
}

/** Opens the object's own surface. */
/** Why an object's surface is opening. */
export type ObjectOpening =
  /** The writer asked to look at an object that already exists. */
  | "engage"
  /** Just created, with nothing to view yet ( sole exception). */
  | "created";

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

/** Supply what Enter opens for one object registration (its `surface` intent). */
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

/** Run an object type's registered engagement — the one way its surface opens. */
export function engageObject(editor: Editor, target: ObjectAt, opening: ObjectOpening): boolean {
  const storage = physicsStorage(editor);
  const spec = objectTypeSpec(target.node);
  if (!storage || spec?.engage !== "surface") return false;
  const engagement = storage.engagements.get(spec.id);
  if (!engagement) return false;
  engagement(target, opening);
  return true;
}

/** Keys that apply only while an object of this registration is selected — Ctrl+Enter for a diagram's source hatch, Alt+Arrows for a move the type owns. */
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
    // The scope already means "an object is selected"; this says which one.
    appliesTo: (context) => context.objectSpec === specId,
    bindings,
  });
}

/** The object whose body `element` is part of, or null outside every object. */
function objectAtDOM(view: EditorView, element: Element): ObjectAt | null {
  let pos: number;
  try {
    pos = view.posAtDOM(element, 0);
  } catch {
    return null;
  }
  if (pos < 0 || pos > view.state.doc.content.size) return null;

  const $pos = view.state.doc.resolve(pos);
  // A leaf object — an image, a scene break — is what the position sits
  // directly before; a block one is an ancestor of the position inside it.
  const after = $pos.nodeAfter;
  if (after && isEditorObject(after)) return { node: after, pos: $pos.pos };

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (isEditorObject(node)) return { node, pos: $pos.before(depth) };
  }
  return null;
}

/** at PRESS time, for an object body the writer cannot type into. */
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

        /** Registration rides the view's lifetime rather than TipTap's `create` event, which is emitted a macrotask late — long enough for a first keystroke to miss it. */
        view(editorView) {
          const chrome = getEditorChrome(editor);
          // Two contributions, because the arrows and Enter are live in
          // different places. Walking ONTO an object starts from prose beside
          // it, so the arrows cannot be scoped to "an object is selected" —
          // they are block-level movement that declines wherever there is no
          // object to step on. Enter genuinely needs the selection.
          const releases = [
            chrome?.registerKeymap({
              id: "object-walk",
              scope: "block",
              bindings: {
                ArrowRight: walkForward,
                ArrowDown: walkForward,
                ArrowLeft: walkBackward,
                ArrowUp: walkBackward,
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
          /** The ring, derived rather than remembered. */
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

          /** A printable character while an object is selected types BESIDE it ( other half). */
          handleTextInput(view, _from, _to, text) {
            const selected = selectedObject(view.state);
            if (!selected) return false;
            const transaction = typeBesideObjectTransaction(view.state, selected.pos, text);
            if (!transaction) return false;
            view.dispatch(transaction);
            return true;
          },

          /**: a click reads. */
          handleClickOn(view, _pos, node, nodePos, _event, direct) {
            if (!direct || !isEditorObject(node)) return false;
            const transaction = selectObjectTransaction(view.state, nodePos);
            if (!transaction) return false;
            view.dispatch(transaction);
            view.focus();
            return true;
          },

          /** The pointer's twin of Enter: a double-click on an object engages it, with no click-to-select step in between. */
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

/** Enter on a selected plain fence puts the caret at its start. */
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

/** The node the ring goes around: any selected node, and a selected table. */
function selectedObjectRange(
  state: Parameters<KeymapBinding>[0],
): { from: number; to: number } | null {
  const object = selectedObject(state);
  if (object) return { from: object.pos, to: object.pos + object.node.nodeSize };
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  return { from: selection.from, to: selection.to };
}

/** Delete and Backspace take the whole object, not the selection over it. */
const removeSelected: KeymapBinding = (state, dispatch) => {
  const selected = selectedObject(state);
  if (!selected) return false;
  const transaction = deleteObjectTransaction(state, selected.pos);
  if (!transaction) return false;
  dispatch?.(transaction);
  return true;
};

const walkForward: KeymapBinding = (state, dispatch) => walk(state, dispatch, 1);
const walkBackward: KeymapBinding = (state, dispatch) => walk(state, dispatch, -1);

function walk(
  state: Parameters<KeymapBinding>[0],
  dispatch: Parameters<KeymapBinding>[1],
  direction: 1 | -1,
): boolean {
  // Second press: pass beyond the object the first press selected.
  const selected = selectedObject(state);
  if (selected) {
    const transaction = caretBesideObjectTransaction(state, selected.pos, direction);
    if (!transaction) return false;
    dispatch?.(transaction);
    return true;
  }

  // First press: the caret is beside an object, so walk onto it.
  const beside = objectBeside(state, direction);
  if (!beside) return false;
  const transaction = selectObjectTransaction(state, beside.pos);
  if (!transaction) return false;
  dispatch?.(transaction);
  return true;
}

/** Registrations already reported as unengageable, so the warning fires once. */
const warnedMissingEngagement = new Set<string>();

/** Enter engages the selected object per its registered intent. */
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
