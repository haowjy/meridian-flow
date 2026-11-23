/**
 * The document's Undo (design §6, "Ctrl+Z is Loro's, grouped by us"): the binding's
 * `UndoHistory`, which keeps one Loro `UndoManager` per text doc the tab changes and the
 * structure values each step set, and groups one editor step across them, so Ctrl+Z takes back
 * the writer's change and leaves a peer's or the model's alone. The history belongs to the `DocumentSession`, so it outlives an editor: each mounted
 * editor attaches while it shows the document.
 */
import type { DocChange, RoomDocs } from "@meridian/document-model";
import { loroSyncKey, notifyChanged, resolveCursor, UndoHistory } from "@meridian/loro-prosemirror";
import type { Editor } from "@tiptap/core";
import { type EditorState, TextSelection } from "@tiptap/pm/state";

const HISTORY_META = "meridian-editor-history";

const histories = new WeakMap<Editor, DocumentHistory>();
const byDocs = new WeakMap<RoomDocs, DocumentHistory>();

export class DocumentHistory {
  /** What the binding records the editor's writes into. */
  readonly steps: UndoHistory;
  private active = true;
  private readonly editors = new Set<Editor>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly docs: RoomDocs,
    /** Sends an Undo's or Redo's changes as one local batch. */
    private readonly publish: (changes: readonly DocChange[]) => void,
  ) {
    this.steps = new UndoHistory(docs);
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

  /** The next write starts its own step. */
  endStep(): void {
    this.steps.endStep();
  }

  /** Frees the history's Loro managers: before the docs are freed. */
  destroy(): void {
    this.active = false;
    this.steps.destroy();
    this.listeners.clear();
  }

  hasEntries(): boolean {
    return this.steps.canUndo() || this.steps.canRedo();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canUndo(): boolean {
    return this.steps.canUndo();
  }

  canRedo(): boolean {
    return this.steps.canRedo();
  }

  /** Undo or Redo the newest step, synchronously. Returns whether a step ran. */
  run(direction: "undo" | "redo", editor: Editor): boolean {
    if (this.docs.isFreed) return false;
    const ran =
      direction === "undo" ? this.steps.undo(editor.state) : this.steps.redo(editor.state);
    if (ran) {
      this.publish(ran.changes);
      notifyChanged(
        this.docs,
        ran.changes.map((change) => change.key),
      );
      const { doc } = editor.state;
      const at = (end: typeof ran.selection.anchor) => end && resolveCursor(this.docs, doc, end);
      const anchor = at(ran.selection.anchor);
      const head = at(ran.selection.head) ?? anchor;
      if (!editor.isDestroyed && anchor != null && head != null)
        editor.view.dispatch(
          editor.state.tr
            .setSelection(TextSelection.create(doc, anchor, head))
            .setMeta("addToHistory", false)
            .scrollIntoView(),
        );
    }
    this.changed();
    return ran !== null;
  }

  private shown = "";

  /**
   * Tells listeners and editors when Undo or Redo becomes available or not: not per keystroke.
   * `source` is the editor whose write this is: its own transaction shows the change.
   */
  changed(source?: Editor): void {
    if (!this.active) return;
    const shown = `${this.canUndo()}|${this.canRedo()}`;
    if (shown === this.shown) return;
    this.shown = shown;
    for (const listener of this.listeners) listener();
    // Not into one composing: a dispatch mid-composition commits its first keystroke as text.
    for (const editor of this.editors)
      if (editor !== source && !editor.isDestroyed && !editor.view.composing)
        editor.view.dispatch(editor.state.tr.setMeta(HISTORY_META, true));
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
