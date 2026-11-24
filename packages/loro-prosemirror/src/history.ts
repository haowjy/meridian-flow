import {
  type DocChange,
  type DocKey,
  type Edit,
  putBackValues,
  type RoomDocs,
  readOf,
  STRUCTURE_KEY,
  UNTRACKED_ORIGIN,
  valuesOf,
} from "@meridian/document-model";
import { Cursor, type LoroDoc, UndoManager } from "loro-crdt";
import type { EditorState } from "prosemirror-state";
import { type SelectionCursors, selectionCursors } from "./cursors.js";

/**
 * Every local writer of a copy with an `UndoHistory` that isn't the editor's own tracked write
 * commits under `UNTRACKED_ORIGIN`, or its commit lands in the Undo stack of the doc it wrote.
 */
export { UNTRACKED_ORIGIN };

/** Writes closer than this join one step. */
const GROUP_MS = 500;
/**
 * Steps kept. A step can be any number of items on a manager (a peer's import splits typing into
 * one per commit), so the managers keep every item, and a step leaves the history whole (`forget`).
 */
const DEPTH = 500;

type End = "anchor" | "head";
/** What each Undo item carries: its step, and which selection ends its cursors are. */
type Tag = { step: number; ends: End[] };
type Step = {
  id: number;
  /** What the step did: its structure values, and the text docs its Loro managers undo. */
  edit: Edit;
  selection: SelectionCursors;
  at: number;
  /** A step this copy's editor did not write (a press): its Undo and Redo are the caller's. */
  outside?: OutsideStep;
};
/** A step taken outside the editor, such as a press: Ctrl+Z runs `undo`, Ctrl+Shift+Z `redo`. */
export type OutsideStep = { undo: () => void; redo: () => void };
type Watched = { manager: UndoManager; doc: LoroDoc };

/** What one Undo or Redo did: the changes to publish, and the selection to put back. */
export interface HistoryRun {
  changes: DocChange[];
  selection: SelectionCursors | null;
}

/**
 * The editor's Ctrl+Z over a copy (design §6, "Ctrl+Z is Loro's, grouped by us"). Text is undone
 * by one Loro `UndoManager` per text doc this copy changes: it keeps each inverse as positions
 * carried through every edit since, so chains of dependent steps undo and redo exactly, and it
 * records only this peer's commits, so Ctrl+Z never takes back a peer's or the model's edit. A
 * step is one or more items on each manager it touched, tagged with the step; Undo runs exactly
 * those managers until their top item is another step's. Structure values are the step's own
 * (the structure doc has no manager), put back by `putBackValues`. Every step runs, whatever was
 * written since (design §2, "An Undo always runs"). A write that sets structure is a step of its
 * own, so typing either side of an Enter is not kept with it; the one exception is typing
 * into an empty paragraph, whose structure write only stores the paragraph (design §1): it joins
 * as typing, so the burst it starts is one step.
 *
 * Every tracked write goes `beforeWrite` → the write's commits → `record` (the binding's plugin
 * does this). A manager is created when the doc is first written (`RoomDocs.beforeTextWrite`);
 * `destroy()` frees them all, and must run before the docs are freed.
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
  /** Whether the write `beforeWrite` announced joins as typing: it leaves the step open. */
  private joining = false;
  private readonly now: () => number;
  private readonly stopWatching: () => void;

  constructor(
    private readonly docs: RoomDocs,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.stopWatching = docs.beforeTextWrite((id, doc) => this.watch(id, doc));
  }

  /**
   * A tracked write is about to run from `state`. Typing (`joins`) joins the open step when it
   * comes soon after the last write, and leaves it open; any other write starts a step, whose
   * selection is `state`'s, taken as cursors before the write so a restored deletion brings the
   * selection back over it, and closes it.
   */
  beforeWrite(state: EditorState, { joins }: { joins: boolean }): void {
    this.joining = joins;
    const now = this.now();
    let step = this.open;
    if (!step || !joins || now - step.at >= GROUP_MS) {
      this.endStep();
      step = {
        id: ++this.ids,
        edit: { values: new Map(), texts: new Map(), read: new Map() },
        selection: selectionCursors(this.docs, state),
        at: now,
      };
      this.open = step;
    }
    this.tag = { step: step.id, selection: step.selection };
  }

  /**
   * A step taken outside the editor (a press) goes on the history as the newest: Ctrl+Z reaching
   * it runs its `undo` and goes no further, which writes nothing here; whatever that does arrives
   * as imports. Redo runs `redo`.
   */
  pushOutside(outside: OutsideStep): void {
    this.endStep();
    this.undoSteps.push({
      id: ++this.ids,
      edit: { values: new Map(), texts: new Map(), read: new Map() },
      selection: { anchor: null, head: null },
      at: this.now(),
      outside,
    });
    if (this.undoSteps.length > DEPTH) this.forget(this.undoSteps.shift() as Step);
    this.clearRedo();
  }

  /** An outside step leaves the history, from either stack: it has nothing left to take back. */
  removeOutside(outside: OutsideStep): void {
    for (const list of [this.undoSteps, this.redoSteps]) {
      const at = list.findIndex((step) => step.outside === outside);
      if (at >= 0) list.splice(at, 1);
    }
  }

  /** An outside step whose Undo didn't happen goes back where Ctrl+Z reaches it again. */
  restoreOutside(outside: OutsideStep): void {
    const at = this.redoSteps.findIndex((step) => step.outside === outside);
    if (at < 0) return;
    const [step] = this.redoSteps.splice(at, 1);
    if (step) this.undoSteps.push(step);
  }

  /** The write `beforeWrite` announced is done; `changes` are what it changed (maybe nothing). */
  record(changes: readonly DocChange[]): void {
    const step = this.open;
    this.tag = null;
    if (!step || changes.length === 0) return;
    const { edit } = step;
    if (edit.texts.size === 0 && edit.values.size === 0) {
      this.undoSteps.push(step);
      this.clearRedo();
      if (this.undoSteps.length > DEPTH) this.forget(this.undoSteps.shift() as Step);
    }
    for (const { key, doc, before, after } of changes) {
      if (key === STRUCTURE_KEY) {
        valuesOf(doc, before, after, edit.values);
        continue;
      }
      const span = edit.texts.get(key);
      if (span) span.after = after;
      else {
        edit.texts.set(key, { before, after });
        // The doc's first commit in the step is an item already; the rest of the step merges into
        // one more. A peer's batch imported meanwhile may split it: the tags still say whose it is.
        this.watched.get(key)?.manager.groupStart();
      }
    }
    // The step's first reading of each doc, which no Undo or Redo reads again: a peer's typing in
    // a block the step made, or one it joined away, stays unread.
    readOf(this.docs, edit, edit.read);
    step.at = this.now();
    if (edit.values.size > 0 && !this.joining) this.endStep();
  }

  /** The next write starts its own step. */
  endStep(): void {
    const step = this.open;
    if (!step) return;
    this.open = null;
    for (const key of step.edit.texts.keys()) this.watched.get(key)?.manager.groupEnd();
  }

  canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  /** Undo the newest step, from the editor at `state`. Null when the history had nothing to undo. */
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
    if (from.length === 0) return null;
    const now = selectionCursors(this.docs, state);
    // A step whose run changes nothing (a peer already took out all it did) leaves the history.
    for (let step = from.pop(); step; step = from.pop()) {
      if (step.outside) {
        to.push(step);
        if (direction === "undo") step.outside.undo();
        else step.outside.redo();
        return { changes: [], selection: null };
      }
      const top = (key: DocKey) => {
        const manager = this.watched.get(key)?.manager;
        return (direction === "undo" ? manager?.topUndoValue() : manager?.topRedoValue()) as
          | Tag
          | undefined;
      };
      this.tag = { step: step.id, selection: now };
      this.popped.clear();
      const changes: DocChange[] = [];
      const inserted = new Set<DocKey>();
      for (const key of step.edit.texts.keys()) {
        const { manager, doc } = this.watched.get(key) as Watched;
        const before = doc.frontiers();
        while (top(key)?.step === step.id) {
          if (direction === "undo") manager.undo();
          else manager.redo();
        }
        const after = doc.frontiers();
        step.edit.texts.set(key, { before, after });
        if (doc.cmpFrontiers(before, after) !== 0) changes.push({ key, doc, before, after });
        const diff = doc.diff(before, after, false).find(([, d]) => d.type === "text")?.[1];
        if (diff?.type === "text" && diff.diff.some((op) => op.insert != null)) inserted.add(key);
      }
      this.tag = null;
      const back = putBackValues(this.docs, step.edit.values, { read: step.edit.read, inserted });
      step.edit.values = back.values;
      changes.push(...back.changes);
      if (changes.length === 0) continue;
      const selection = this.restored(step.selection);
      step.selection = now;
      to.push(step);
      return { changes, selection };
    }
    return { changes: [], selection: null };
  }

  /**
   * `step` leaves the history as it fell off its end. Its items stay at the bottom of its docs'
   * managers, under every kept step's, where no run reaches them; a manager no kept step has items
   * on starts again empty, so they are freed.
   */
  private forget(step: Step): void {
    const kept = (key: DocKey) =>
      [this.undoSteps, this.redoSteps].some((list) => list.some(({ edit }) => edit.texts.has(key)));
    for (const key of step.edit.texts.keys()) if (!kept(key)) this.restart(key);
  }

  /** The manager of doc `key` starts again empty. */
  private restart(key: DocKey): void {
    const watched = this.watched.get(key);
    if (!watched) return;
    watched.manager.free();
    watched.manager = this.manager(key, watched.doc);
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
    this.watched.set(key, { manager: this.manager(key, doc), doc });
  }

  private manager(key: DocKey, doc: LoroDoc): UndoManager {
    return new UndoManager(doc, {
      mergeInterval: 0,
      // The history keeps steps, not items (`DEPTH`): Loro would drop the oldest item of a step.
      maxUndoSteps: Number.POSITIVE_INFINITY,
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
  }
}
