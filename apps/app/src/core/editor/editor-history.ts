import type { DocChange, RoomDocs } from "@meridian/document-model";
import {
  type HistoryRun,
  loroSyncKey,
  notifyChanged,
  type OutsideStep,
  resolveCursor,
  UndoHistory,
} from "@meridian/loro-prosemirror";
import type { Editor } from "@tiptap/core";
import { type EditorState, TextSelection } from "@tiptap/pm/state";

const HISTORY_META = "meridian-editor-history";

const histories = new WeakMap<Editor, DocumentHistory>();
const byDocs = new WeakMap<RoomDocs, DocumentHistory>();

export class DocumentHistory {
  readonly steps: UndoHistory;
  private active = true;
  private readonly editors = new Set<Editor>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly docs: RoomDocs,
    private readonly publish: (changes: readonly DocChange[]) => void,
  ) {
    this.steps = new UndoHistory(docs);
    byDocs.set(docs, this);
  }

  attach(editor: Editor): () => void {
    histories.set(editor, this);
    this.editors.add(editor);
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(HISTORY_META, true));
    return () => {
      this.editors.delete(editor);
      histories.delete(editor);
    };
  }

  endStep(): void {
    this.steps.endStep();
  }

  destroy(): void {
    this.active = false;
    this.steps.destroy();
    this.listeners.clear();
  }

  get open(): boolean {
    return this.editors.size > 0;
  }

  pushOutside(step: OutsideStep): void {
    this.steps.pushOutside(step);
    this.changed();
  }

  removeOutside(step: OutsideStep): void {
    this.steps.removeOutside(step);
    this.changed();
  }

  restoreOutside(step: OutsideStep): void {
    this.steps.restoreOutside(step);
    this.changed();
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

  run(direction: "undo" | "redo", editor: Editor): HistoryRun | null {
    if (this.docs.isFreed) return null;
    const ran =
      direction === "undo" ? this.steps.undo(editor.state) : this.steps.redo(editor.state);
    if (ran && ran.changes.length > 0) {
      this.publish(ran.changes);
      notifyChanged(
        this.docs,
        ran.changes.map((change) => change.key),
      );
    }
    const selection = ran?.selection;
    if (selection) {
      const { doc } = editor.state;
      const at = (end: typeof selection.anchor) => end && resolveCursor(this.docs, doc, end);
      const anchor = at(selection.anchor);
      const head = at(selection.head) ?? anchor;
      if (!editor.isDestroyed && anchor != null && head != null)
        editor.view.dispatch(
          editor.state.tr
            .setSelection(TextSelection.create(doc, anchor, head))
            .setMeta("addToHistory", false)
            .scrollIntoView(),
        );
    }
    this.changed();
    return ran;
  }

  private shown = "";

  changed(source?: Editor): void {
    if (!this.active) return;
    const shown = `${this.canUndo()}|${this.canRedo()}`;
    if (shown === this.shown) return;
    this.shown = shown;
    for (const listener of this.listeners) listener();
    for (const editor of this.editors)
      if (editor !== source && !editor.isDestroyed && !editor.view.composing)
        editor.view.dispatch(editor.state.tr.setMeta(HISTORY_META, true));
  }
}

export function endUndoStep(state: EditorState): void {
  const docs = loroSyncKey.getState(state)?.docs;
  if (docs) byDocs.get(docs)?.endStep();
}

export function editorHistory(editor: Editor): DocumentHistory | null {
  return histories.get(editor) ?? null;
}

export function undoEditorHistory(editor: Editor): boolean {
  return (histories.get(editor)?.run("undo", editor) ?? null) !== null;
}

export function redoEditorHistory(editor: Editor): boolean {
  return (histories.get(editor)?.run("redo", editor) ?? null) !== null;
}

export function canUndoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.canUndo() ?? false;
}

export function canRedoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.canRedo() ?? false;
}
