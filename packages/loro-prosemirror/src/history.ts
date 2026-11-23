import {
  type DocChange,
  type DocKey,
  type Edit,
  editStays,
  noteEdit,
  opsBetween,
  putBackValues,
  type RoomDocs,
  STRUCTURE_KEY,
  StructureView,
  takeBackMessage,
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
/** Steps kept; each doc's manager keeps twice as many items (a step is one or two per doc). */
const DEPTH = 500;

type End = "anchor" | "head";
/** What each Undo item carries: its step, and which selection ends its cursors are. */
type Tag = { step: number; ends: End[] };
type Step = {
  id: number;
  /** What the step did, for the rule; its text docs are undone by their Loro managers. */
  edit: Edit;
  selection: SelectionCursors;
  at: number;
};
type Watched = { manager: UndoManager; doc: LoroDoc };

/**
 * What one Undo or Redo did: the changes to publish, the selection to put back (null when no step
 * ran), and how many steps it found written over and took out of the history.
 */
export interface HistoryRun {
  changes: DocChange[];
  selection: SelectionCursors | null;
  stayed: number;
}

/**
 * The editor's Ctrl+Z over a copy (design §6, "Ctrl+Z is Loro's, grouped by us"). Text is undone
 * by one Loro `UndoManager` per text doc this copy changes: it keeps each inverse as positions
 * carried through every edit since, so chains of dependent steps undo and redo exactly, and it
 * records only this peer's commits, so Ctrl+Z never takes back a peer's or the model's edit. A
 * step is one or more items on each manager it touched, tagged with the step; Undo runs exactly
 * those managers until their top item is another step's. Structure values are the step's own
 * (the structure doc has no manager).
 *
 * A step goes back whole or stays whole (design §2, "An Undo takes an edit back whole"): before a
 * run, `editStays` tests it. A step someone else wrote over writes nothing; Loro's managers cannot
 * drop one item, so the managers of its text docs start again empty, and every step with an item
 * in one of them leaves the history too, as does every step that set one of its keys, through
 * all they share. Ctrl+Z then goes on to the step before. A write that sets structure is a step
 * of its own, so typing either side of an Enter is not kept with it.
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
  private readonly now: () => number;
  private readonly stopWatching: () => void;
  /** Why the last step found written over stayed (a probe reads it). */
  why = "";

  constructor(
    private readonly docs: RoomDocs,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.stopWatching = docs.beforeTextWrite((id, doc) => this.watch(id, doc));
  }

  /**
   * A tracked write is about to run from `state`. Typing (`joins`) joins the open step when it
   * comes soon after the last write; any other write starts a step, whose selection is `state`'s,
   * taken as cursors before the write so a restored deletion brings the selection back over it.
   */
  beforeWrite(state: EditorState, joins: boolean): void {
    const now = this.now();
    let step = this.open;
    if (!step || !joins || now - step.at >= GROUP_MS) {
      this.endStep();
      step = {
        id: ++this.ids,
        edit: {
          values: new Map(),
          texts: new Map(),
          leaving: new Map(),
          arriving: new Set(),
          shown: new Set(),
        },
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
    const { edit } = step;
    if (edit.texts.size === 0 && edit.values.size === 0) {
      this.undoSteps.push(step);
      if (this.undoSteps.length > DEPTH) this.undoSteps.shift();
      this.clearRedo();
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
    step.at = this.now();
    if (edit.values.size > 0) {
      noteEdit(this.docs, edit);
      this.endStep();
    }
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

  /**
   * Undo the newest step that can go back whole, from the editor at `state`. Null when the
   * history had nothing to undo.
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
    if (from.length === 0) return null;
    const now = selectionCursors(this.docs, state);
    let stayed = 0;
    for (let step = from.pop(); step; step = from.pop()) {
      // One read serves the test and the put-back: the managers between them write only text.
      const view = step.edit.values.size > 0 ? new StructureView(this.docs) : undefined;
      const why = editStays(this.docs, step.edit, view);
      if (why) {
        this.why = why;
        stayed += this.drop(step);
        continue;
      }
      this.tag = { step: step.id, selection: now };
      this.popped.clear();
      const changes: DocChange[] = [];
      for (const [key, span] of step.edit.texts) {
        const watched = this.watched.get(key);
        if (!watched) continue;
        const { manager, doc } = watched;
        const top = () =>
          (direction === "undo" ? manager.topUndoValue() : manager.topRedoValue()) as
            | Tag
            | undefined;
        const before = doc.frontiers();
        // Loro commits an Undo and a Redo alike under the origin `undo`: the message says which
        // ops the commit takes back, so text it puts back can be told from typing.
        const message = takeBackMessage(opsBetween(doc, span.before, span.after, this.docs.peer));
        // The modifier, and the one `setMessage` returns for chaining, are handles of our own.
        const unstamp = doc.subscribePreCommit(({ modifier }) => {
          modifier.setMessage(message).free();
          modifier.free();
        });
        try {
          while (top()?.step === step.id) {
            if (direction === "undo") manager.undo();
            else manager.redo();
          }
        } finally {
          unstamp();
        }
        const after = doc.frontiers();
        step.edit.texts.set(key, { before, after });
        if (doc.cmpFrontiers(before, after) !== 0) changes.push({ key, doc, before, after });
      }
      this.tag = null;
      const back = putBackValues(this.docs, step.edit.values, view);
      step.edit.values = back.values;
      if (back.change) changes.push(back.change);
      noteEdit(this.docs, step.edit);
      if (changes.length === 0) continue;
      const selection = this.restored(step.selection);
      step.selection = now;
      to.push(step);
      return { changes, selection, stayed };
    }
    return { changes: [], selection: null, stayed };
  }

  /**
   * `step` stays, as a peer's edit would, and writes nothing. Loro's manager cannot drop an item
   * from under the ones on top of it, so the managers of the step's text docs start again empty,
   * and every step with an item in one of them leaves the history, Undo and Redo alike; so does
   * every step that set one of the same structure keys, whose Undo would otherwise pass over the
   * kept value as this copy's own write. Returns how many steps left.
   */
  private drop(step: Step): number {
    const docs = new Set<DocKey>();
    const keys = new Set<string>();
    const take = ({ edit }: Step) => {
      for (const key of edit.texts.keys()) docs.add(key);
      for (const [name, values] of edit.values)
        for (const key of values.keys()) keys.add(`${name}\u0000${key}`);
    };
    const shares = ({ edit }: Step) =>
      [...edit.texts.keys()].some((key) => docs.has(key)) ||
      [...edit.values].some(([name, values]) =>
        [...values.keys()].some((key) => keys.has(`${name}\u0000${key}`)),
      );
    take(step);
    let dropped = 1;
    for (let grew = true; grew; ) {
      grew = false;
      for (const list of [this.undoSteps, this.redoSteps])
        for (let i = list.length - 1; i >= 0; i--)
          if (shares(list[i])) {
            take(list[i]);
            list.splice(i, 1);
            dropped++;
            grew = true;
          }
    }
    for (const key of docs) {
      const watched = this.watched.get(key);
      if (!watched) continue;
      watched.manager.free();
      watched.manager = this.manager(key, watched.doc);
    }
    return dropped;
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
  }
}
