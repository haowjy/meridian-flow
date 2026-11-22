/**
 * The document's Undo (design §2's one Undo rule, §6 "Ctrl+Z is ours"): every write an editor
 * makes is recorded as the docs it changed with their frontiers either side (the binding's
 * `onLocalWrite`), and Ctrl+Z inverts the newest step at its own frontiers (`invertChange`), so it
 * takes back the writer's change and leaves a peer's or the model's alone. Redo inverts the
 * inverse. The history belongs to the `DocumentSession`, so it outlives an editor: each mounted
 * editor attaches while it shows the document.
 */
import {
  type DocChange,
  type Inverse,
  invertChange,
  type RoomDocs,
} from "@meridian/document-model";
import { loroSyncKey, notifyChanged } from "@meridian/loro-prosemirror";
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { findBlock } from "./loro-points";

/** Keystrokes closer than this join one Undo step. */
const GROUP_MS = 500;
const HISTORY_META = "meridian-editor-history";

/** A caret end as a block and an offset in its text, which survives a peer's edit elsewhere. */
type Point = { block: string; offset: number } | null;
type Step = { changes: DocChange[]; anchor: Point; head: Point; at: number };

const histories = new WeakMap<Editor, DocumentHistory>();
const byDocs = new WeakMap<RoomDocs, DocumentHistory>();

function pointOf(doc: Node, pos: number): Point {
  const $pos = doc.resolve(pos);
  const id = $pos.parent.attrs.id;
  return $pos.parent.isTextblock && typeof id === "string"
    ? { block: id, offset: $pos.parentOffset }
    : null;
}

function resolveAt(doc: Node, point: Point): number | null {
  if (!point) return null;
  const found = findBlock(doc, point.block);
  return found?.node.isTextblock
    ? found.pos + 1 + Math.min(point.offset, found.node.content.size)
    : null;
}

export class DocumentHistory {
  private readonly undoSteps: Step[] = [];
  private readonly redoSteps: Step[] = [];
  private closed = true;
  private active = true;
  private readonly editors = new Set<Editor>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly docs: RoomDocs,
    /** Sends an Undo's or Redo's inverses as one local batch. */
    private readonly publish: (inverses: readonly Inverse[]) => void,
  ) {
    byDocs.set(docs, this);
  }

  /** Follow an editor while it is mounted. Returns the detach. */
  attach(editor: Editor): () => void {
    histories.set(editor, this);
    this.editors.add(editor);
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(HISTORY_META, true));
    return () => {
      this.editors.delete(editor);
      histories.delete(editor);
    };
  }

  /**
   * One local write from an editor: joins the open step when it comes soon after the last, else
   * starts one. `before` is the editor state the transaction started from (its selection is what
   * Undo puts back). A new write clears Redo. A write marked `addToHistory: false` is no one's to
   * take back and closes the open step: bookkeeping between two edits keeps them apart (an
   * upload's token leaving before its picture lands).
   */
  record(changes: readonly DocChange[], tr: Transaction, before: EditorState): void {
    if (!this.active || changes.length === 0) return;
    if (tr.getMeta("addToHistory") === false) {
      this.closed = true;
      return;
    }
    const now = Date.now();
    const last = this.undoSteps.at(-1);
    if (last && !this.closed && now - last.at < GROUP_MS) {
      last.changes.push(...changes);
      last.at = now;
    } else {
      const { selection } = before;
      this.undoSteps.push({
        changes: [...changes],
        anchor: pointOf(before.doc, selection.anchor),
        head: pointOf(before.doc, selection.head),
        at: now,
      });
    }
    this.closed = false;
    this.redoSteps.length = 0;
    this.changed();
  }

  /** The next write starts its own step. */
  endStep(): void {
    this.closed = true;
  }

  destroy(): void {
    this.active = false;
    this.undoSteps.length = 0;
    this.redoSteps.length = 0;
    this.listeners.clear();
  }

  hasEntries(): boolean {
    return this.undoSteps.length > 0 || this.redoSteps.length > 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  /**
   * Undo or Redo the newest step, synchronously. A step whose inverses change nothing (a peer took
   * the text out already) is skipped for the next one. Returns whether a step ran.
   */
  run(direction: "undo" | "redo", editor: Editor): boolean {
    if (this.docs.isFreed) return false;
    const from = direction === "undo" ? this.undoSteps : this.redoSteps;
    const to = direction === "undo" ? this.redoSteps : this.undoSteps;
    this.closed = true;
    for (let step = from.pop(); step; step = from.pop()) {
      const inverses: Inverse[] = [];
      for (const change of [...step.changes].reverse()) {
        const inverse = invertChange(this.docs, change);
        if (inverse) inverses.push(inverse);
      }
      if (inverses.length === 0) continue;
      this.publish(inverses);
      notifyChanged(
        this.docs,
        inverses.map((inverse) => inverse.change.key),
      );
      const selection = editor.isDestroyed ? null : editor.state.selection;
      to.push({
        changes: inverses.map((inverse) => inverse.change),
        anchor: selection ? pointOf(editor.state.doc, selection.anchor) : step.anchor,
        head: selection ? pointOf(editor.state.doc, selection.head) : step.head,
        at: 0,
      });
      if (!editor.isDestroyed) {
        const { doc } = editor.state;
        const anchor = resolveAt(doc, step.anchor);
        const head = resolveAt(doc, step.head) ?? anchor;
        if (anchor !== null && head !== null)
          editor.view.dispatch(
            editor.state.tr
              .setSelection(TextSelection.create(doc, anchor, head))
              .setMeta("addToHistory", false)
              .scrollIntoView(),
          );
      }
      this.changed();
      return true;
    }
    this.changed();
    return false;
  }

  private changed(): void {
    if (!this.active) return;
    for (const listener of this.listeners) listener();
    for (const editor of this.editors)
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(HISTORY_META, true));
  }
}

/**
 * Ends the Undo step now open, so the next edit starts its own. A site whose edit must be its own
 * step (an upload landing, a link action, an `@` reference, a block drop) calls this first.
 */
export function endUndoStep(state: EditorState): void {
  const docs = loroSyncKey.getState(state)?.docs;
  if (docs) byDocs.get(docs)?.endStep();
}

export function editorHistory(editor: Editor): DocumentHistory | null {
  return histories.get(editor) ?? null;
}

export function undoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.run("undo", editor) ?? false;
}

export function redoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.run("redo", editor) ?? false;
}

export function canUndoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.canUndo() ?? false;
}

export function canRedoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.canRedo() ?? false;
}
