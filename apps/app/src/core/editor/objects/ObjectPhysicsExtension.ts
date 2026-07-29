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
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { getEditorChrome } from "../chrome/ChromeKernelExtension";
import type { KeymapBinding } from "../chrome/keymap";
import {
  caretBesideObjectTransaction,
  caretInsideObjectTransaction,
  objectBeside,
  selectedObject,
  selectObjectTransaction,
} from "./object-selection";
import { isEditorObject, objectTypeSpec } from "./object-types";

const OBJECT_PHYSICS_NAME = "meridianObjectPhysics";

export const objectPhysicsPluginKey = new PluginKey(OBJECT_PHYSICS_NAME);

/** Opens the object's own surface. Return false to let the key fall through. */
export type ObjectEngagement = (target: {
  node: import("@tiptap/pm/model").Node;
  pos: number;
}) => boolean;

type ObjectPhysicsStorage = {
  engagements: Map<string, ObjectEngagement>;
  release: (() => void)[];
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

  const scoped: Record<string, KeymapBinding> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    scoped[key] = (state, dispatch, view) => {
      const selected = selectedObject(state);
      if (!selected || selected.node.type.name !== nodeType) return false;
      return binding(state, dispatch, view);
    };
  }

  return chrome.registerKeymap({ id: `object:${nodeType}`, scope: "object", bindings: scoped });
}

export const ObjectPhysicsExtension = Extension.create({
  name: OBJECT_PHYSICS_NAME,
  // Under the chrome kernel (1050) and undo (1100): object physics is the
  // deepest thing in the document, never the outermost thing on screen.
  priority: 1040,

  addStorage(): ObjectPhysicsStorage {
    return { engagements: new Map(), release: [] };
  },

  onCreate() {
    const chrome = getEditorChrome(this.editor);
    if (!chrome) return;
    const storage = this.storage;
    const engagements = storage.engagements;

    storage.release.push(
      chrome.registerKeymap({
        id: "object-physics",
        scope: "object",
        bindings: {
          ArrowRight: walkForward,
          ArrowDown: walkForward,
          ArrowLeft: walkBackward,
          ArrowUp: walkBackward,
          Enter: (state, dispatch) => engage(state, dispatch, engagements),
        },
      }),
    );
  },

  onDestroy() {
    const storage = this.storage;
    for (const release of storage.release) release();
    storage.release.length = 0;
    storage.engagements.clear();
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: objectPhysicsPluginKey,
        props: {
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
        },
      }),
    ];
  },
});

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

/**
 * Enter engages the selected object per its registered intent (§4). A
 * `surface` type with no handler yet declines the key rather than doing
 * something else: an object whose lane has not shipped is inert, not wrong.
 */
function engage(
  state: Parameters<KeymapBinding>[0],
  dispatch: Parameters<KeymapBinding>[1],
  engagements: Map<string, ObjectEngagement>,
): boolean {
  const selected = selectedObject(state);
  if (!selected) return false;

  const spec = objectTypeSpec(selected.node);
  if (!spec || spec.engage === "none") return false;

  if (spec.engage === "surface") {
    return engagements.get(spec.nodeType)?.(selected) ?? false;
  }

  const transaction = caretInsideObjectTransaction(state, selected.pos);
  if (!transaction) return false;
  dispatch?.(transaction);
  return true;
}
