/** One mounted editor's chronological history across Yjs edits and editor Apply commands. */
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type { UndoManager } from "yjs";

type StackItem = UndoManager["undoStack"][number];

type EditorHistoryAction = {
  undo(): void;
  redo(): void;
};
export type EditorHistoryHandle = {
  captureApply(action: EditorHistoryAction): void;
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
  private active = true;

  constructor(private readonly editor: Editor) {
    const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
    if (!manager) throw new Error("Editor history requires collaborative undo");
    this.manager = manager;
    manager.on("stack-item-added", this.managerAdded);
    manager.on("stack-cleared", this.managerCleared);
  }

  destroy(): void {
    this.active = false;
    this.manager.off("stack-item-added", this.managerAdded);
    this.manager.off("stack-cleared", this.managerCleared);
    this.undo.length = 0;
    this.redo.length = 0;
  }

  captureApply(action: EditorHistoryAction): void {
    if (!this.active) return;
    this.manager.stopCapturing();
    this.undo.push({ kind: "apply", sequence: ++this.sequence, action });
    this.clearRedo();
    this.changed();
  }

  canUndo(): boolean {
    return this.active && this.undo.length > 0;
  }

  canRedo(): boolean {
    return this.active && this.redo.length > 0;
  }

  run(direction: "undo" | "redo"): boolean {
    if (!this.active) return false;
    const source = direction === "undo" ? this.undo : this.redo;
    const entry = direction === "undo" ? source.at(-1) : source[0];
    if (!entry) return false;
    if (entry.kind === "apply") {
      source.splice(direction === "undo" ? source.length - 1 : 0, 1);
      insert(direction === "undo" ? this.redo : this.undo, entry);
      entry.action[direction]();
    } else {
      this.runNative(direction, source);
    }
    this.changed();
    return true;
  }

  /** Let Yjs skip native no-ops, but never let that traversal cross an Apply boundary. */
  private runNative(direction: "undo" | "redo", source: Entry[]): void {
    const segment: Extract<Entry, { kind: "yjs" }>[] = [];
    if (direction === "undo") {
      for (let index = source.length - 1; index >= 0; index--) {
        const entry = source[index];
        if (!entry || entry.kind === "apply") break;
        segment.push(entry);
      }
    } else {
      for (const entry of source) {
        if (entry.kind === "apply") break;
        segment.push(entry);
      }
    }
    const allowed = new Set(segment.map((entry) => entry.item));
    const stack = direction === "undo" ? this.manager.undoStack : this.manager.redoStack;
    const original = [...stack];
    stack.splice(0, stack.length, ...original.filter((item) => allowed.has(item)));

    this.suppressManagerEvents = true;
    this.managerGenerated = null;
    let popped: StackItem | null = null;
    try {
      popped = direction === "undo" ? this.manager.undo() : this.manager.redo();
    } finally {
      this.suppressManagerEvents = false;
    }

    this.reconcileNativeSegment(source, stack, original, allowed);

    const generated = this.managerGenerated as StackItem | null;
    if (popped && generated) {
      const known = popped.meta.get(HISTORY_META) as Entry | undefined;
      const moved: Entry = {
        kind: "yjs",
        sequence: known?.sequence ?? segment[0]?.sequence ?? ++this.sequence,
        item: generated,
      };
      generated.meta.set(HISTORY_META, moved);
      insert(direction === "undo" ? this.redo : this.undo, moved);
    }
  }

  /** Remove only items Yjs consumed from the segment it was allowed to traverse. */
  private reconcileNativeSegment(
    source: Entry[],
    stack: StackItem[],
    original: readonly StackItem[],
    allowed: ReadonlySet<StackItem>,
  ): void {
    const remaining = new Set(stack);
    const survives = (item: StackItem) => !allowed.has(item) || remaining.has(item);
    stack.splice(0, stack.length, ...original.filter(survives));
    source.splice(
      0,
      source.length,
      ...source.filter((entry) => entry.kind === "apply" || survives(entry.item)),
    );
  }

  private readonly managerAdded = ({ stackItem, type }: { stackItem: StackItem; type: string }) => {
    if (!this.active) return;
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
  };

  private readonly managerCleared = ({
    undoStackCleared,
    redoStackCleared,
  }: {
    undoStackCleared: boolean;
    redoStackCleared: boolean;
  }) => {
    if (!this.active || this.suppressManagerEvents) return;
    if (undoStackCleared) this.removeMissing(this.undo, new Set(this.manager.undoStack));
    if (redoStackCleared) this.removeMissing(this.redo, new Set(this.manager.redoStack));
    queueMicrotask(() => this.changed());
  };

  private removeMissing(entries: Entry[], retained: Set<StackItem>): void {
    entries.splice(
      0,
      entries.length,
      ...entries.filter((entry) => entry.kind === "apply" || retained.has(entry.item)),
    );
  }

  private clearRedo(): void {
    this.redo.length = 0;
    if (this.manager.redoStack.length > 0) {
      this.suppressManagerEvents = true;
      try {
        this.manager.clear(false, true);
      } finally {
        this.suppressManagerEvents = false;
      }
    }
  }

  private changed(): void {
    if (!this.active || this.editor.isDestroyed) return;
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
