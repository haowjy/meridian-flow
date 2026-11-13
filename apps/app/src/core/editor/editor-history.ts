/**
 * One document's chronological history across Yjs edits and editor Apply commands. The
 * session owns it, so it outlives the editors that attach to it while mounted.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  getRelativeSelection,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

type StackItem = Y.UndoManager["undoStack"][number];

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

/** The history each mounted editor is attached to. */
const histories = new WeakMap<Editor, DocumentHistory>();
const HISTORY_META = "meridian-editor-history";
/** On a stack item: the range selection from just before the change it holds ran. */
const RANGE_META = "meridian-editor-range";

type RelativeSelection = ReturnType<typeof getRelativeSelection>;

function insert(entries: Entry[], entry: Entry): void {
  const index = entries.findIndex((candidate) => candidate.sequence > entry.sequence);
  entries.splice(index < 0 ? entries.length : index, 0, entry);
}

/**
 * A relative position as a document position, or null when it no longer
 * stands for live text. `relativePositionToAbsolutePosition` resolves a
 * position inside a deleted paragraph to wherever the walk ends up, often the
 * end of the document, so any deleted ancestor counts as unresolved.
 */
export function liveAbsolutePosition(
  binding: {
    doc: Y.Doc;
    type: Y.XmlFragment;
    mapping: Parameters<typeof relativePositionToAbsolutePosition>[3];
  },
  relative: RelativeSelection["anchor"],
): number | null {
  const decoded = Y.createAbsolutePositionFromRelativePosition(relative, binding.doc);
  if (!decoded) return null;
  for (let type: Y.AbstractType<unknown> | null = decoded.type; type; ) {
    const item: Y.Item | null = type._item;
    if (item?.deleted) return null;
    type = (item?.parent as Y.AbstractType<unknown> | null | undefined) ?? null;
  }
  return relativePositionToAbsolutePosition(binding.doc, binding.type, relative, binding.mapping);
}

/**
 * The manager y-tiptap would build for an editor, built once per document. Only edits
 * written through an editor (`ySyncPluginKey`) are tracked: peer and model edits arrive
 * under other origins, so undo reverts the writer's own and nothing else.
 */
function createDocumentUndoManager(document: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), {
    trackedOrigins: new Set([ySyncPluginKey]),
    deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
    captureTransaction: (transaction) => transaction.meta.get("addToHistory") !== false,
  });
}

export class DocumentHistory implements EditorHistoryHandle {
  private readonly undo: Entry[] = [];
  private readonly redo: Entry[] = [];
  private sequence = 0;
  private suppressManagerEvents = false;
  private managerGenerated: StackItem | null = null;
  /** The range selected when the dispatch now running began, for the stack item that dispatch adds. */
  private rangeBeforeDispatch: RelativeSelection | null = null;
  private active = true;
  /** The editors showing this document now. */
  private readonly editors = new Set<Editor>();

  constructor(readonly manager: Y.UndoManager) {
    manager.on("stack-item-added", this.managerAdded);
    manager.on("stack-cleared", this.managerCleared);
  }

  static forDocument(document: Y.Doc): DocumentHistory {
    return new DocumentHistory(createDocumentUndoManager(document));
  }

  /** Follow an editor while it is mounted: its ranges and its toolbar state. Returns the detach. */
  attach(editor: Editor): () => void {
    histories.set(editor, this);
    this.editors.add(editor);
    editor.on("beforeTransaction", this.rememberRange);
    return () => {
      editor.off("beforeTransaction", this.rememberRange);
      this.editors.delete(editor);
      histories.delete(editor);
    };
  }

  destroy(): void {
    this.active = false;
    this.manager.off("stack-item-added", this.managerAdded);
    this.manager.off("stack-cleared", this.managerCleared);
    this.manager.destroy();
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

  run(direction: "undo" | "redo", editor: Editor): boolean {
    if (!this.active) return false;
    const source = direction === "undo" ? this.undo : this.redo;
    const entry = direction === "undo" ? source.at(-1) : source[0];
    if (!entry) return false;
    if (entry.kind === "apply") {
      source.splice(direction === "undo" ? source.length - 1 : 0, 1);
      insert(direction === "undo" ? this.redo : this.undo, entry);
      entry.action[direction]();
    } else {
      this.runNative(direction, source, editor);
    }
    this.changed();
    return true;
  }

  /** Let Yjs skip native no-ops, but never let that traversal cross an Apply boundary. */
  private runNative(direction: "undo" | "redo", source: Entry[], editor: Editor): void {
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
    if (popped && direction === "undo") this.restoreRange(popped, editor);
    if (popped && generated) {
      const range = popped.meta.get(RANGE_META) as RelativeSelection | undefined;
      if (range) generated.meta.set(RANGE_META, range);
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

  /**
   * Gives back the range a change started from. Yjs undo maps the selection
   * the document has now, and a range that was moved or replaced has just been
   * removed, so it collapses into a caret. Every stack item that holds a change
   * from a range carries it in `RANGE_META`: taken by `rememberRange` before
   * the dispatch that made the item, then carried through the items UndoManager
   * generates for later redo and undo runs. Redo leaves y-tiptap's mapped
   * selection alone. (y-tiptap saves its own copy on each item, but reads
   * it from the last transaction of a dispatch, which is the wrong range when a
   * plugin appends one.) Carets keep the mapped result, and so do node
   * selections, unless their object has gone, which `ObjectPhysicsExtension`
   * turns into a caret.
   */
  private restoreRange(popped: StackItem, editor: Editor): void {
    const binding = ySyncPluginKey.getState(editor.state)?.binding;
    const before = popped.meta.get(RANGE_META) as RelativeSelection | undefined;
    if (!binding || before?.type !== "text") return;
    const anchor = liveAbsolutePosition(binding, before.anchor);
    const head = liveAbsolutePosition(binding, before.head);
    if (anchor === null || head === null || anchor === head) return;
    const { state, view } = editor;
    view.dispatch(
      state.tr
        .setSelection(TextSelection.between(state.doc.resolve(anchor), state.doc.resolve(head)))
        .scrollIntoView(),
    );
  }

  /**
   * Remembers the range an editor change started from. `beforeTransaction`
   * still sees the state the change applies to; the stack item it adds is
   * created within that dispatch, so the microtask drops the memory once the
   * dispatch is done (a transaction a filter rejects never reaches
   * `transaction`, and a later write that didn't come from the editor must not
   * inherit the range).
   */
  private readonly rememberRange = ({
    editor,
    transaction,
  }: {
    editor: Editor;
    transaction: Transaction;
  }) => {
    const { selection } = editor.state;
    const binding = ySyncPluginKey.getState(editor.state)?.binding;
    if (
      !binding ||
      !transaction.docChanged ||
      transaction.getMeta(ySyncPluginKey) ||
      !(selection instanceof TextSelection) ||
      selection.empty
    ) {
      return;
    }
    this.rangeBeforeDispatch = getRelativeSelection(binding, editor.state);
    queueMicrotask(() => {
      this.rangeBeforeDispatch = null;
    });
  };

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
    if (this.rangeBeforeDispatch) stackItem.meta.set(RANGE_META, this.rangeBeforeDispatch);
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

  /** Tells every attached editor, so a toolbar showing this document refreshes its Undo state. */
  private changed(): void {
    if (!this.active) return;
    for (const editor of this.editors)
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(HISTORY_META, true));
  }
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
