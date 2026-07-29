/**
 * ObjectPhysicsExtension — the second register's physics (§1, laws 1–3).
 *
 * A click selects an object instead of opening it. Arrows walk onto it and
 * then past it. Enter engages it, per type. Esc walks home, which is the
 * kernel's chain rather than this file's business. A tap is a click, so touch
 * comes free.
 *
 * The per-type parts are contributions, not branches here: `object-types.ts`
 * says what Enter means for a type, `registerObjectEngagement` is how a lane
 * supplies the surface Enter opens, and `registerObjectKeymap` is how it adds
 * keys that only apply while its object is selected. This file knows about no
 * particular object.
 *
 * Keys go through the kernel's keymap ladder at scope `object`, so a surface
 * open over the document (scope `layer`) still gets the arrow keys first.
 */

import { type Editor, Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { getEditorChrome } from "../chrome/ChromeKernelExtension";
import type { KeymapBinding } from "../chrome/keymap";
import {
  caretBesideObjectTransaction,
  caretInsideObjectTransaction,
  type ObjectAt,
  objectBeside,
  selectedObject,
  selectObjectTransaction,
} from "./object-selection";
import { isEditorObject, objectTypeSpec } from "./object-types";

const OBJECT_PHYSICS_NAME = "meridianObjectPhysics";

export const objectPhysicsPluginKey = new PluginKey(OBJECT_PHYSICS_NAME);

/**
 * The class the jade ring paints on — law 1's click, read back.
 *
 * NOT ProseMirror's own `ProseMirror-selectednode`. That one is applied once,
 * imperatively, by a node view's `selectNode` lifecycle call, and a remote
 * write does not go through it: y-prosemirror rebuilds the document from the
 * Yjs type, the node views are replaced under a selection that never changed,
 * and nothing tells the new one it is selected. The ring vanished on a peer's
 * first keystroke and never came back — not even on re-selecting — for the
 * rest of the session.
 *
 * A decoration has no such lifecycle. ProseMirror derives it from state on
 * every view update, so a rebuilt view is built holding it.
 */
export const SELECTED_OBJECT_CLASS = "meridian-object-selected";

/**
 * Opens the object's own surface.
 *
 * It returns nothing, and that is the contract rather than an omission: Enter
 * on a selected object is consumed whether or not this runs. Letting the key
 * fall through would hand a node selection to the base keymap, which splits
 * the block around it and leaves stray paragraphs in the manuscript — a
 * structural edit from a key that was supposed to open something.
 */
/**
 * Why an object's surface is opening.
 *
 * A surface usually shows what is already there; one opening on an object made
 * a moment ago has nothing to show, and law 2's exception says it opens ready
 * to work instead. Only the lane that owns the surface can act on that, so the
 * physics carries the reason rather than deciding for it.
 */
export type ObjectOpening =
  /** The writer asked to look at an object that already exists. */
  | "engage"
  /** Just created, with nothing to view yet (law 2's sole exception). */
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

/**
 * Supply what Enter opens for one object type (its `surface` intent). Keyed by
 * node type: a type that is only sometimes an object — a mermaid fence — gets
 * the whole node and decides for itself.
 */
export function registerObjectEngagement(
  editor: Editor,
  nodeType: string,
  engagement: ObjectEngagement,
): () => void {
  const storage = physicsStorage(editor);
  if (!storage) return () => {};
  storage.engagements.set(nodeType, engagement);
  return () => {
    if (storage.engagements.get(nodeType) === engagement) storage.engagements.delete(nodeType);
  };
}

/**
 * Run an object type's registered engagement — the one way its surface opens.
 *
 * `opening` is why, and the surface is entitled to care: law 2 lets a
 * just-created object open ready to work, because there is nothing to view
 * yet, while everything else opens on what is there. Enter and a double-click
 * say `engage`; the lane that just made the object says `created`.
 *
 * False means no lane has registered a surface, and the caller keeps whatever
 * opening it already made.
 */
export function engageObject(editor: Editor, target: ObjectAt, opening: ObjectOpening): boolean {
  const storage = physicsStorage(editor);
  const spec = objectTypeSpec(target.node);
  if (!storage || spec?.engage !== "surface") return false;
  const engagement = storage.engagements.get(spec.nodeType);
  if (!engagement) return false;
  engagement(target, opening);
  return true;
}

/**
 * Keys that apply only while an object of `nodeType` is selected — Ctrl+Enter
 * for a diagram's source hatch, Alt+Arrows for a move the type owns. They
 * register at the kernel's `object` scope, so an open menu still wins.
 */
export function registerObjectKeymap(
  editor: Editor,
  nodeType: string,
  bindings: Readonly<Record<string, KeymapBinding>>,
): () => void {
  const chrome = getEditorChrome(editor);
  if (!chrome) return () => {};

  return chrome.registerKeymap({
    id: `object:${nodeType}`,
    scope: "object",
    // The scope already means "an object is selected"; this says which one.
    appliesTo: (context) => context.nodeType === nodeType,
    bindings,
  });
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
         * Registration rides the view's lifetime rather than TipTap's `create`
         * event, which is emitted a macrotask late — long enough for a first
         * keystroke to miss it.
         */
        view() {
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
              id: "object-engage",
              scope: "object",
              bindings: { Enter: (state, dispatch) => engage(editor, state, dispatch) },
            }),
          ];

          return {
            destroy() {
              for (const release of releases) release?.();
              engagements.clear();
            },
          };
        },

        props: {
          /**
           * The ring, derived rather than remembered. Every node ProseMirror
           * has selected wears it, which is the same set its own
           * `ProseMirror-selectednode` covers — a table is the deliberate
           * exception, because prosemirror-tables normalizes its selection to
           * every cell and paints its own tint across them.
           */
          decorations(state) {
            const { selection } = state;
            if (!(selection instanceof NodeSelection)) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(selection.from, selection.to, { class: SELECTED_OBJECT_CLASS }),
            ]);
          },

          /**
           * Law 1: a click reads. On an object that reading is a selection,
           * never its source. `direct` keeps the click at the node the pointer
           * actually hit — without it, a click in a table cell would walk out
           * to the table and select the whole thing.
           */
          handleClickOn(view, _pos, node, nodePos, _event, direct) {
            if (!direct || !isEditorObject(node)) return false;
            const transaction = selectObjectTransaction(view.state, nodePos);
            if (!transaction) return false;
            view.dispatch(transaction);
            view.focus();
            return true;
          },

          /**
           * The pointer's twin of Enter (§5.2, §5.6): a double-click on an
           * object engages it, with no click-to-select step in between.
           *
           * The same registered engagement Enter uses, so a lane wires its
           * surface once and both doors open it. In prose this stands aside
           * and the browser's word selection happens as it always did.
           */
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

function reportMissingEngagement(nodeType: string): void {
  if (!import.meta.env?.DEV || warnedMissingEngagement.has(nodeType)) return;
  warnedMissingEngagement.add(nodeType);
  console.warn(
    `[editor] "${nodeType}" is registered with engage: "surface", but no lane called registerObjectEngagement — Enter on it does nothing.`,
  );
}

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

/** Node types already reported as unengageable, so the warning fires once. */
const warnedMissingEngagement = new Set<string>();

/**
 * Enter engages the selected object per its registered intent (§4).
 *
 * A selected object ALWAYS consumes the key, even when its intent is `none`
 * or its lane has not shipped the surface yet — see `ObjectEngagement` for
 * why falling through would edit the document.
 *
 * A `surface` type with no handler is therefore a dead key, which law 5
 * forbids on anything shipped. It is legal only while its lane is unbuilt, so
 * it says so in development rather than waiting to be found by a writer
 * pressing Enter on a diagram and getting nothing.
 */
function engage(
  editor: Editor,
  state: Parameters<KeymapBinding>[0],
  dispatch: Parameters<KeymapBinding>[1],
): boolean {
  const selected = selectedObject(state);
  if (!selected) return false;

  const spec = objectTypeSpec(selected.node);
  if (!spec) return false;

  if (spec.engage === "surface") {
    if (!engageObject(editor, selected, "engage")) reportMissingEngagement(spec.nodeType);
    return true;
  }

  if (spec.engage === "caret-inside") {
    const transaction = caretInsideObjectTransaction(state, selected.pos);
    if (transaction) dispatch?.(transaction);
  }

  return true;
}
