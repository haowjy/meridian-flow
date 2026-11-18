/**
 * One document's chronological history across Yjs edits and editor Apply commands. The
 * session owns it, so it outlives the editors that attach to it while mounted.
 */
import type { Editor } from "@tiptap/core";
import { type EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  getRelativeSelection,
  relativePositionToAbsolutePosition,
  resolveRelativeCellSelection,
  ySyncPluginKey,
  yUndoPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";
import { markStepDone, touchedSince } from "./touched-since";

type StackItem = Y.UndoManager["undoStack"][number];

type EditorHistoryAction = {
  /**
   * Resolves false when the undo didn't happen: the entry goes back to the undo side at its
   * place, unless it was redone or cleared since.
   */
  undo(): Promise<boolean>;
  redo(): void;
  /**
   * The Apply waits for an owner to reopen: an undo passes over its entry to the one under it,
   * and its boundary still keeps the edits on either side apart.
   */
  passedOver?(): boolean;
  /** An undo just passed over it: the writer pressed Undo and an older step went instead. */
  passed?(): void;
  /** Its redo is gone: new edits cleared the redo side, or the history closed with it there. */
  dropped?(): void;
};
/** An Apply boundary in a history. `remove` ends it when its action can no longer run. */
type ApplyEntry = { remove(): void };
/**
 * `hide` takes the entry out of both sides and keeps its place; `show` puts a hidden entry back on
 * the undo side at that place, below what was done after it, and leaves the redo side alone.
 * `restate`: whether it is passed over changed, so what Undo offers is read again.
 */
export type DocumentApplyEntry = ApplyEntry & { hide(): void; show(): void; restate(): void };
export type EditorHistoryHandle = {
  captureApply(action: EditorHistoryAction): ApplyEntry;
};

type Entry =
  | { kind: "yjs"; sequence: number; item: StackItem }
  | { kind: "apply"; sequence: number; action: EditorHistoryAction; presses: number };

/** The history each mounted editor is attached to. */
const histories = new WeakMap<Editor, DocumentHistory>();
const noop = () => {};
const HISTORY_META = "meridian-editor-history";
/** On a stack item: the range selection from just before the change it holds ran. */
const RANGE_META = "meridian-editor-range";
/** On a stack item: its `Guard`. */
const GUARD_META = "meridian-editor-guard";

type Guard = { dropped(): void };

type RelativeSelection = ReturnType<typeof getRelativeSelection>;

const passedOver = (entry: Entry) => entry.kind === "apply" && entry.action.passedOver?.() === true;

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
 * under other origins, so undo reverts the writer's own and nothing else. A block's `id` is its
 * identity, not content: undo never takes one away. A protected paragraph survives its creator's
 * undo, so without the filter a peer's text would be left in a paragraph with no id.
 */
function createDocumentUndoManager(document: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), {
    trackedOrigins: new Set([ySyncPluginKey]),
    deleteFilter: (item) =>
      item.parentSub !== "id" && defaultDeleteFilter(item, defaultProtectedNodes),
    // A binding write is the writer's only with the sync plugin's mark: its own repairs open a
    // transaction with the same origin and no mark, and never land on the writer's undo stack. Other
    // origins (this manager's undo and redo, a Discard, an Apply) are tracked by their own.
    captureTransaction: (transaction) =>
      transaction.origin !== ySyncPluginKey || transaction.meta.get("addToHistory") === true,
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
  /** Apply entries hidden while an Un-Apply sent from elsewhere is out: they may come back. */
  private hiddenApplies = 0;
  /** The editors showing this document now. */
  private readonly editors = new Set<Editor>();
  private readonly listeners = new Set<() => void>();

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
    // The toolbar read Undo before the editor had this history: tiptap's `onCreate` comes later.
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(HISTORY_META, true));
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
    const redone = this.redo.splice(0);
    this.undo.length = 0;
    this.hiddenApplies = 0;
    this.listeners.clear();
    for (const entry of redone) if (entry.kind === "apply") entry.action.dropped?.();
  }

  captureApply(action: EditorHistoryAction): DocumentApplyEntry {
    if (!this.active) return { remove: noop, hide: noop, show: noop, restate: noop };
    this.manager.stopCapturing();
    const entry: Entry = { kind: "apply", sequence: ++this.sequence, action, presses: 0 };
    this.undo.push(entry);
    this.clearRedo();
    this.changed();
    let hidden = false;
    const take = () => {
      for (const entries of [this.undo, this.redo]) {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      }
      this.changed();
    };
    const unhide = () => {
      if (!hidden) return;
      hidden = false;
      this.hiddenApplies--;
    };
    return {
      remove: () => {
        unhide();
        take();
      },
      hide: () => {
        if (hidden) return;
        hidden = true;
        this.hiddenApplies++;
        take();
      },
      show: () => {
        if (!hidden || !this.active) return;
        unhide();
        insert(this.undo, entry);
        this.changed();
      },
      restate: () => this.changed(),
    };
  }

  /**
   * Whether undoing or redoing has anything to lose; the owner of the session keeps it while so. An
   * Apply passed over for a closed owner counts: Undo takes it once the owner reopens. So does a
   * hidden Apply, which may come back.
   */
  hasEntries(): boolean {
    return this.active && (this.undo.length > 0 || this.redo.length > 0 || this.hiddenApplies > 0);
  }

  /** Calls `listener` after the stacks change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canUndo(): boolean {
    return this.active && this.undo.some((entry) => !passedOver(entry));
  }

  canRedo(): boolean {
    return this.active && this.redo.length > 0;
  }

  run(direction: "undo" | "redo", editor: Editor): boolean {
    if (!this.active) return false;
    const source = direction === "undo" ? this.undo : this.redo;
    const entry = direction === "undo" ? source.findLast((each) => !passedOver(each)) : source[0];
    const over = direction === "undo" ? source.slice(entry ? source.indexOf(entry) + 1 : 0) : [];
    const passed = () => {
      for (const each of over) if (each.kind === "apply") each.action.passed?.();
    };
    if (!entry) {
      passed();
      return false;
    }
    if (entry.kind === "apply") {
      source.splice(source.indexOf(entry), 1);
      insert(direction === "undo" ? this.redo : this.undo, entry);
      const press = ++entry.presses;
      if (direction === "redo") entry.action.redo();
      else
        void entry.action.undo().then((happened) => {
          if (!happened && entry.presses === press) this.reinstate(entry);
        });
      passed();
    } else if (this.runNative(direction, source, editor)) passed();
    this.changed();
    return true;
  }

  /** Puts an Apply whose undo didn't happen back on the undo side, if it still waits for redo. */
  private reinstate(entry: Entry): void {
    const at = this.redo.indexOf(entry);
    if (!this.active || at < 0) return;
    this.redo.splice(at, 1);
    insert(this.undo, entry);
    this.changed();
  }

  /**
   * Undo may take the step back only while what it wrote stands as it left it (a Discard): Ctrl+Z
   * drops it unrun once a later edit touched that text (`touchedSince`, from `markStepDone`), and
   * calls `dropped`. Its Redo is guarded the same way, from the state the Redo left.
   */
  guard(item: StackItem, dropped: () => void): void {
    item.meta.set(GUARD_META, { dropped } satisfies Guard);
  }

  /** Takes a step out of the history: its owner undid it some other way. */
  take(item: StackItem): void {
    for (const stack of [this.manager.undoStack, this.manager.redoStack]) {
      const at = stack.indexOf(item);
      if (at >= 0) stack.splice(at, 1);
    }
    this.removeMissing(this.undo, new Set(this.manager.undoStack));
    this.removeMissing(this.redo, new Set(this.manager.redoStack));
    this.changed();
  }

  /**
   * Let Yjs skip native no-ops, but never let that traversal cross an Apply boundary or reach a
   * guarded step: that one runs alone, once its guard says it still can. An undo passes over an
   * Apply that waits for a closed owner, as a press does.
   */
  private runNative(direction: "undo" | "redo", source: Entry[], editor: Editor): boolean {
    const segment: Extract<Entry, { kind: "yjs" }>[] = [];
    if (direction === "undo") {
      for (let index = source.length - 1; index >= 0; index--) {
        const entry = source[index];
        if (entry && passedOver(entry)) continue;
        if (!entry || entry.kind === "apply") break;
        const guard = entry.item.meta.get(GUARD_META) as Guard | undefined;
        if (guard && segment.length) break;
        segment.push(entry);
        if (!guard) continue;
        if (!touchedSince(this.manager.doc, entry.item)) break;
        this.take(entry.item);
        guard.dropped();
        return false;
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
      const guard = popped.meta.get(GUARD_META) as Guard | undefined;
      if (guard) {
        markStepDone(this.manager.doc, generated);
        this.guard(generated, guard.dropped);
      }
      const known = popped.meta.get(HISTORY_META) as Entry | undefined;
      const moved: Entry = {
        kind: "yjs",
        sequence: known?.sequence ?? segment[0]?.sequence ?? ++this.sequence,
        item: generated,
      };
      generated.meta.set(HISTORY_META, moved);
      insert(direction === "undo" ? this.redo : this.undo, moved);
    }
    return true;
  }

  /**
   * Gives back the range a change started from. Yjs undo maps the selection
   * the document has now, and a range that was moved or replaced has just been
   * removed, so it collapses into a caret. Every stack item that holds a change
   * from a range carries it in `RANGE_META`: taken by `rememberRange` before
   * the dispatch that made the item, then carried through the items UndoManager
   * generates for later redo and undo runs. Redo leaves y-tiptap's mapped
   * selection alone. Cell ranges use the binding's identity-aware resolver; if
   * either endpoint is gone, the binding's mapped result stays.
   * (y-tiptap saves its own copy on each item, but reads
   * it from the last transaction of a dispatch, which is the wrong range when a
   * plugin appends one.) Carets keep the mapped result, and so do node
   * selections, unless their object has gone, which `ObjectPhysicsExtension`
   * turns into a caret.
   */
  private restoreRange(popped: StackItem, editor: Editor): void {
    const binding = ySyncPluginKey.getState(editor.state)?.binding;
    const before = popped.meta.get(RANGE_META) as RelativeSelection | undefined;
    if (!binding || !before) return;
    if (before.type === "cell") {
      const { selection } = resolveRelativeCellSelection(editor.state.doc, before, binding);
      if (selection) editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
      return;
    }
    if (before.type !== "text") return;
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
      !(selection instanceof TextSelection || selection instanceof CellSelection) ||
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
    this.notify();
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

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private clearRedo(): void {
    for (const entry of this.redo.splice(0)) if (entry.kind === "apply") entry.action.dropped?.();
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
    this.notify();
    for (const editor of this.editors)
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(HISTORY_META, true));
  }
}

/**
 * Ends the Undo step now open, so the next edit starts its own. A step boundary must call this:
 * y-tiptap closes the capture window only for a document-changing transaction marked
 * `addToHistory: false`, never for a meta-only one, and a time window alone merges quick edits.
 */
export function endUndoStep(state: EditorState): void {
  yUndoPluginKey.getState(state)?.undoManager.stopCapturing();
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
