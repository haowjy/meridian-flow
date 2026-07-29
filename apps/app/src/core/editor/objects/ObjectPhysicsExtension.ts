/**
 * ObjectPhysicsExtension — the second register's physics (§1, laws 1–3).
 *
 * A click selects an object instead of opening it — and on an object with no
 * inside, the PRESS does, before the browser can park a caret in content the
 * object is not showing (`selectObjectUnderPress`). Arrows walk onto it and
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
 * Supply what Enter opens for one object registration (its `surface` intent).
 *
 * Keyed by the registration's `id`, never by its node type: one node type
 * carries several registrations — every fenced diagram dialect is a `code_block`
 * — and a node-type key would let the second dialect overwrite the first's
 * surface. `objectTypeSpec(node).id` is how a caller names the registration a
 * node matched.
 */
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
  const engagement = storage.engagements.get(spec.id);
  if (!engagement) return false;
  engagement(target, opening);
  return true;
}

/**
 * Keys that apply only while an object of this registration is selected —
 * Ctrl+Enter for a diagram's source hatch, Alt+Arrows for a move the type owns.
 * They register at the kernel's `object` scope, so an open menu still wins.
 *
 * Keyed by registration for the same reason engagements are: the selected fence
 * is a diagram of one particular dialect, and the resolved context names which
 * (`chrome/chrome-context.ts`).
 */
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

/**
 * The object whose body `element` is part of, or null outside every object.
 *
 * Reads the DOM rather than the pointer's coordinates: a press lands on a
 * `<polygon>` in a diagram or on an `<img>`, and both are somewhere ProseMirror
 * can map back to a position, while coordinates can fall in a gap between
 * boxes. The walk is over the DOCUMENT — the position's own ancestors — so it
 * finds the object however many node views the press happened to land inside.
 */
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

/**
 * Law 1 at PRESS time, for an object body the writer cannot type into.
 *
 * `handleClickOn` is a mouseup path, and one repaint too late. Between the two
 * events the browser answers the press its own way: pressing something marked
 * `contenteditable="false"` sends it hunting for the nearest editable position,
 * and inside a node view that hides its own text — a rendered diagram — the
 * nearest one is that hidden text. The caret lands there, the node view brings
 * the source back so those keystrokes stay reachable, the page moves under the
 * pointer, and the mouseup lands in the source it just revealed. A press that
 * travels more than a few pixels never reaches `handleClickOn` at all, so the
 * source simply stays.
 *
 * The rule is the DOM's own, not a list of node types: **an object body that
 * refuses a caret takes the press.** A plain fence and a table cell are
 * editable, their click IS a caret (§5.3, §5.4), and neither is touched here.
 *
 * One object leaves the press alone all the same: the kind that travels by
 * ProseMirror's own drag to land between two words. Chrome will not start a
 * drag out of a press whose default was refused, so refusing here is refusing
 * the gesture — and there is nothing to protect the writer from, because the
 * nearest editable position beside an inline picture is the sentence it is
 * already standing in. The click that never travels still rings it, one
 * mouseup later, through `handleClickOn`.
 *
 * Bound as a plain listener rather than through `handleDOMEvents`, which reads
 * a prevented default as "the plugin owns the whole press" and skips the mouse
 * machinery that counts clicks and double-clicks. This has to run beside that
 * machinery, not instead of it.
 */
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
         * Registration rides the view's lifetime rather than TipTap's `create`
         * event, which is emitted a macrotask late — long enough for a first
         * keystroke to miss it.
         */
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
              // Not `object` scope: §4's Enter row covers a selected plain
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
          /**
           * The ring, derived rather than remembered.
           *
           * Every node ProseMirror has selected wears it — the same set its
           * own `ProseMirror-selectednode` covers — and so does a selected
           * table, whose selection is a `CellSelection` over every cell that
           * no `NodeSelection` test can see. Leaving the table out left the
           * one gesture that selects it without asking (Delete at the end of
           * the line above) showing the writer nothing at all before the next
           * press took the table.
           */
          decorations(state) {
            const range = selectedObjectRange(state);
            if (!range) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(range.from, range.to, { class: SELECTED_OBJECT_CLASS }),
            ]);
          },

          /**
           * A printable character while an object is selected types BESIDE it
           * (law 1's other half).
           *
           * ProseMirror replaces the selection, which is right for prose and
           * wrong here: closing an image's full-screen view leaves the picture
           * node-selected, and the next letter used to be the end of the
           * picture. A table selected by the join gesture lost every cell to
           * the same keystroke. Only `Delete` and `Backspace` are destructive
           * verbs, and they still are.
           *
           * `selectedObject` is the whole gate, which is why a writer sweeping
           * across some cells still types over them: that is a partial
           * `CellSelection` — a deliberate edit inside the table — and the
           * table is not standing there as an object.
           */
          handleTextInput(view, _from, _to, text) {
            const selected = selectedObject(view.state);
            if (!selected) return false;
            const transaction = typeBesideObjectTransaction(view.state, selected.pos, text);
            if (!transaction) return false;
            view.dispatch(transaction);
            return true;
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

/**
 * Enter on a selected plain fence puts the caret at its start (§4).
 *
 * Its own text is what there is to engage — a code block's rendering IS its
 * source, so there is no surface to open and nothing to convert. Falling
 * through to the base keymap instead appended a paragraph after the fence and
 * left the caret in it.
 */
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

/**
 * Delete and Backspace take the whole object, not the selection over it.
 *
 * They differ for exactly one type and that is the type it matters for: a
 * table is selected as a `CellSelection` across every cell, so the base
 * keymap's `deleteSelection` empties the cells and leaves the grid. The join
 * reflex — Delete at the end of the line above a table — lands on that
 * selection, so the second press wiped the table's contents while its shell
 * stayed put.
 */
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
