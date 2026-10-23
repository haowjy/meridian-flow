/** One mounted editor's chronological history across Yjs edits and editor Apply commands. */
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type { UndoManager } from "yjs";

type StackItem = UndoManager["undoStack"][number];

export type EditorHistoryActionResult = "done" | "discard" | "failed";
export type EditorHistoryAction = {
  undo(): Promise<EditorHistoryActionResult>;
  redo(): Promise<EditorHistoryActionResult>;
};
export type EditorHistoryHandle = {
  captureApply(action: EditorHistoryAction): { retry(): boolean };
};

type Entry =
  | { kind: "yjs"; sequence: number; item: StackItem }
  | { kind: "apply"; sequence: number; action: EditorHistoryAction };

const histories = new WeakMap<Editor, MountedEditorHistory>();
const HISTORY_META = "meridian-editor-history";

function insert(entries: Entry[], entry: Entry): void {
  const index = entries.findIndex((candidate) => candidate.sequence > entry.sequence);
  entries.splice(index < 0 ? entries.length : index, 0, entry);
}

class MountedEditorHistory implements EditorHistoryHandle {
  private readonly manager: UndoManager;
  private readonly undo: Entry[] = [];
  private readonly redo: Entry[] = [];
  private sequence = 0;
  private suppressManagerEvents = false;
  private managerGenerated: StackItem | null = null;
  private operation = Promise.resolve();
  private redoGeneration = 0;
  private readonly failed = new Map<Entry, "undo" | "redo">();

  constructor(private readonly editor: Editor) {
    const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
    if (!manager) throw new Error("Editor history requires collaborative undo");
    this.manager = manager;
    manager.on("stack-item-added", this.managerAdded);
    manager.on("stack-cleared", this.managerCleared);
  }

  destroy(): void {
    this.manager.off("stack-item-added", this.managerAdded);
    this.manager.off("stack-cleared", this.managerCleared);
    this.undo.length = 0;
    this.redo.length = 0;
  }

  captureApply(action: EditorHistoryAction): { retry(): boolean } {
    this.manager.stopCapturing();
    const entry: Entry = { kind: "apply", sequence: ++this.sequence, action };
    this.undo.push(entry);
    this.clearRedo();
    this.manager.stopCapturing();
    this.changed();
    return { retry: () => this.retry(entry) };
  }

  canUndo(): boolean {
    return this.undo.length > 0;
  }

  canRedo(): boolean {
    return this.redo.length > 0;
  }

  run(direction: "undo" | "redo"): boolean {
    const source = direction === "undo" ? this.undo : this.redo;
    const entry = source.pop();
    if (!entry) return false;
    const generation = this.redoGeneration;
    this.changed();
    this.schedule(entry, direction, source, generation);
    return true;
  }

  private retry(entry: Entry): boolean {
    const direction = this.failed.get(entry);
    if (!direction) return false;
    const source = direction === "undo" ? this.undo : this.redo;
    const index = source.indexOf(entry);
    if (index < 0) return false;
    source.splice(index, 1);
    this.changed();
    this.schedule(entry, direction, source, this.redoGeneration);
    return true;
  }

  private schedule(
    entry: Entry,
    direction: "undo" | "redo",
    source: Entry[],
    generation: number,
  ): void {
    this.operation = this.operation.then(async () => {
      if (entry.kind === "yjs") {
        this.suppressManagerEvents = true;
        this.managerGenerated = null;
        let popped: StackItem | null = null;
        try {
          popped = direction === "undo" ? this.manager.undo() : this.manager.redo();
        } finally {
          this.suppressManagerEvents = false;
        }
        const remaining = new Set(
          direction === "undo" ? this.manager.undoStack : this.manager.redoStack,
        );
        source.splice(
          0,
          source.length,
          ...source.filter(
            (candidate) => candidate.kind === "apply" || remaining.has(candidate.item),
          ),
        );
        const generated = this.managerGenerated as StackItem | null;
        if (popped && generated) {
          const known = popped.meta.get(HISTORY_META) as Entry | undefined;
          const moved: Entry = {
            kind: "yjs",
            sequence: known?.sequence ?? entry.sequence,
            item: generated,
          };
          generated.meta.set(HISTORY_META, moved);
          insert(direction === "undo" ? this.redo : this.undo, moved);
        }
      } else {
        let result: EditorHistoryActionResult = "failed";
        try {
          result = await entry.action[direction]();
        } catch {
          result = "failed";
        }
        if (result === "failed") {
          insert(source, entry);
          this.failed.set(entry, direction);
        } else if (result === "done") {
          this.failed.delete(entry);
          const destination = direction === "undo" ? this.redo : this.undo;
          if (direction === "redo" || generation === this.redoGeneration)
            insert(destination, entry);
        }
      }
      this.changed();
    });
  }

  private readonly managerAdded = ({ stackItem, type }: { stackItem: StackItem; type: string }) => {
    if (this.suppressManagerEvents) {
      this.managerGenerated = stackItem;
      return;
    }
    if (type !== "undo") return;
    const known = stackItem.meta.get(HISTORY_META) as Entry | undefined;
    if (known) return;
    const entry: Entry = { kind: "yjs", sequence: ++this.sequence, item: stackItem };
    stackItem.meta.set(HISTORY_META, entry);
    this.undo.push(entry);
    this.clearRedo();
    // The editor transaction that created this Yjs item already refreshes toolbar state.
  };

  private readonly managerCleared = ({
    undoStackCleared,
    redoStackCleared,
  }: {
    undoStackCleared: boolean;
    redoStackCleared: boolean;
  }) => {
    if (this.suppressManagerEvents) return;
    if (undoStackCleared)
      this.undo.splice(0, this.undo.length, ...this.undo.filter((entry) => entry.kind === "apply"));
    if (redoStackCleared)
      this.redo.splice(0, this.redo.length, ...this.redo.filter((entry) => entry.kind === "apply"));
    queueMicrotask(() => this.changed());
  };

  private clearRedo(): void {
    this.redo.length = 0;
    this.redoGeneration++;
  }

  private changed(): void {
    if (this.editor.isDestroyed) return;
    this.editor.view.dispatch(this.editor.state.tr.setMeta(HISTORY_META, true));
  }
}

export function mountEditorHistory(editor: Editor): void {
  if (!histories.has(editor)) histories.set(editor, new MountedEditorHistory(editor));
}

export function unmountEditorHistory(editor: Editor): void {
  histories.get(editor)?.destroy();
  histories.delete(editor);
}

export function editorHistory(editor: Editor): EditorHistoryHandle | null {
  return histories.get(editor) ?? null;
}

export function undoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.run("undo") ?? false;
}

export function redoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.run("redo") ?? false;
}

export function canUndoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.canUndo() ?? false;
}

export function canRedoEditorHistory(editor: Editor): boolean {
  return histories.get(editor)?.canRedo() ?? false;
}
