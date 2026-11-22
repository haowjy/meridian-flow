import {
  type DocChange,
  type DocKey,
  type RoomDocs,
  STRUCTURE_KEY,
} from "@meridian/document-model";
import { Cursor, type LoroDoc, UndoManager } from "loro-crdt";
import type { EditorState } from "prosemirror-state";
import { type SelectionCursors, selectionCursors } from "./cursors.js";

/**
 * The commit origin of a local write no Ctrl+Z takes back: a transaction marked
 * `addToHistory: false`, or a write made outside the editor. Every local writer of a copy with
 * an `UndoHistory` that isn't the editor's own tracked write commits under it, or its commit
 * lands in the Undo stack of the doc it wrote.
 */
export const UNTRACKED_ORIGIN = "untracked";

/** Writes closer than this join one step. */
const GROUP_MS = 500;
/** Steps kept; each doc's manager keeps twice as many items (a step is one or two per doc). */
const DEPTH = 500;

type End = "anchor" | "head";
/** What each Undo item carries: its step, and which selection ends its cursors are. */
type Tag = { step: number; ends: End[] };
type Step = { id: number; keys: Set<DocKey>; selection: SelectionCursors; at: number };
type Watched = { manager: UndoManager; doc: LoroDoc };

/** What one Undo or Redo did: the changes to publish, and the selection to put back. */
export interface HistoryRun {
  changes: DocChange[];
  selection: SelectionCursors;
}

/**
 * The editor's Ctrl+Z over a copy (design §6, "Ctrl+Z is Loro's, grouped by us"): one Loro
 * `UndoManager` per doc this copy changes, and steps that group them. Loro's manager keeps each
 * inverse as positions carried through every edit since, so chains of dependent steps undo and
 * redo exactly, and it records only this peer's commits, so Ctrl+Z never takes back a peer's or
 * the model's edit. A step is one or more items on each manager it touched, tagged with the
 * step; Undo runs exactly those managers until their top item is another step's.
 *
 * Every tracked write goes `beforeWrite` → the write's commits → `record` (the binding's plugin
 * does this). A manager is created when the doc is first written (`RoomDocs.beforeTextWrite`), the
 * structure's at once; `destroy()` frees them all, and must run before the docs are freed.
 */
export class UndoHistory {
  private readonly watched = new Map<DocKey, Watched>();
  private readonly undoSteps: Step[] = [];
  private readonly redoSteps: Step[] = [];
  /** The step writes join until it closes. */
  private open: Step | null = null;
  /** What a commit pushed now is tagged with: the step being written, undone or redone. */
  private tag: { step: number; selection: SelectionCursors } | null = null;
  /** The cursors each selection end came back with from the items popped in a run. */
  private readonly popped = new Map<End, Uint8Array>();
  /** The cursors the last push handed to Loro: still ours to free. */
  private pushed: Cursor[] = [];
  private ids = 0;
  private readonly stopWatching: () => void;

  constructor(private readonly docs: RoomDocs) {
    this.watch(STRUCTURE_KEY, docs.structure);
    this.stopWatching = docs.beforeTextWrite((id, doc) => this.watch(id, doc));
  }

  /**
   * A tracked write is about to run from `state`: it joins the open step when it comes soon after
   * the last write, else starts one whose selection is `state`'s, taken as cursors before the
   * write so a restored deletion brings the selection back over it.
   */
  beforeWrite(state: EditorState): void {
    const now = Date.now();
    let step = this.open;
    if (!step || now - step.at >= GROUP_MS) {
      this.endStep();
      step = {
        id: ++this.ids,
        keys: new Set(),
        selection: selectionCursors(this.docs, state),
        at: now,
      };
      this.open = step;
    }
    this.tag = { step: step.id, selection: step.selection };
  }

  /** The write `beforeWrite` announced is done; `changes` are what it changed (maybe nothing). */
  record(changes: readonly DocChange[]): void {
    const step = this.open;
    this.tag = null;
    if (!step || changes.length === 0) return;
    if (step.keys.size === 0) {
      this.undoSteps.push(step);
      if (this.undoSteps.length > DEPTH) this.undoSteps.shift();
      this.clearRedo();
    }
    for (const { key } of changes) {
      if (step.keys.has(key)) continue;
      step.keys.add(key);
      // The doc's first commit in the step is an item already; the rest of the step merges into
      // one more. A peer's batch imported meanwhile may split it: the tags still say whose it is.
      this.watched.get(key)?.manager.groupStart();
    }
    step.at = Date.now();
  }

  /** The next write starts its own step. */
  endStep(): void {
    const step = this.open;
    if (!step) return;
    this.open = null;
    for (const key of step.keys) this.watched.get(key)?.manager.groupEnd();
  }

  canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  /**
   * Undo the newest step, from the editor at `state`. A step whose items change nothing now (a
   * peer deleted what it wrote) is dropped for the one before it. Null when nothing ran.
   */
  undo(state: EditorState): HistoryRun | null {
    return this.run("undo", state);
  }

  redo(state: EditorState): HistoryRun | null {
    return this.run("redo", state);
  }

  destroy(): void {
    this.stopWatching();
    this.freePushed();
    for (const { manager } of this.watched.values()) manager.free();
    this.watched.clear();
    this.undoSteps.length = 0;
    this.redoSteps.length = 0;
    this.open = null;
  }

  private run(direction: "undo" | "redo", state: EditorState): HistoryRun | null {
    this.endStep();
    const [from, to] =
      direction === "undo" ? [this.undoSteps, this.redoSteps] : [this.redoSteps, this.undoSteps];
    const now = selectionCursors(this.docs, state);
    for (let step = from.pop(); step; step = from.pop()) {
      this.tag = { step: step.id, selection: now };
      this.popped.clear();
      const changes: DocChange[] = [];
      for (const key of step.keys) {
        const watched = this.watched.get(key);
        if (!watched) continue;
        const { manager, doc } = watched;
        const top = () =>
          (direction === "undo" ? manager.topUndoValue() : manager.topRedoValue()) as
            | Tag
            | undefined;
        const before = doc.frontiers();
        while (top()?.step === step.id) {
          if (direction === "undo") manager.undo();
          else manager.redo();
        }
        const after = doc.frontiers();
        if (doc.cmpFrontiers(before, after) !== 0) changes.push({ key, doc, before, after });
      }
      this.tag = null;
      if (changes.length === 0) continue;
      const selection = this.restored(step.selection);
      step.selection = now;
      to.push(step);
      return { changes, selection };
    }
    return null;
  }

  /** A step's selection, each end moved to the cursor its doc's popped item carried back. */
  private restored(selection: SelectionCursors): SelectionCursors {
    const end = (name: End) => {
      const at = selection[name];
      const cursor = this.popped.get(name);
      return at && cursor ? { ...at, cursor } : at;
    };
    return { anchor: end("anchor"), head: end("head") };
  }

  private freePushed(): void {
    for (const cursor of this.pushed) cursor.free();
    this.pushed = [];
  }

  private clearRedo(): void {
    if (this.redoSteps.length === 0) return;
    this.redoSteps.length = 0;
    for (const { manager } of this.watched.values()) manager.clearRedo();
  }

  private watch(key: DocKey, doc: LoroDoc): void {
    if (this.watched.has(key)) return;
    const manager = new UndoManager(doc, {
      mergeInterval: 0,
      maxUndoSteps: DEPTH * 2,
      excludeOriginPrefixes: [UNTRACKED_ORIGIN],
      // Loro keeps the cursors an item is pushed with and hands them back moved through its
      // inverse, so a selection over deleted text covers the text the Undo puts back.
      onPush: () => {
        const tag = this.tag;
        // A commit with no step's tag and not UNTRACKED_ORIGIN would sit on top of this doc's
        // undo stack and make Ctrl+Z skip everything older on it. Always a missing origin.
        if (!tag && typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
          throw new Error("Local commit without a history step tag or UNTRACKED_ORIGIN");
        }
        const ends: End[] = [];
        const cursors: Cursor[] = [];
        for (const name of ["anchor", "head"] as const) {
          const at = tag?.selection[name];
          if (at?.block !== key) continue;
          ends.push(name);
          cursors.push(Cursor.decode(at.cursor));
        }
        // Loro copies these once this callback returns, so the next push frees them.
        this.freePushed();
        this.pushed = cursors;
        return { value: tag ? ({ step: tag.step, ends } satisfies Tag) : null, cursors };
      },
      onPop: (_isUndo, { value, cursors }) => {
        const ends = (value as Tag | null)?.ends ?? [];
        cursors.forEach((cursor, i) => {
          const name = ends[i];
          if (name) this.popped.set(name, cursor.encode());
          cursor.free();
        });
      },
    });
    this.watched.set(key, { manager, doc });
  }
}
