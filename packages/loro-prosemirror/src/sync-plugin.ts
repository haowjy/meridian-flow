import {
  type BlockId,
  commentVisibility,
  type DocChange,
  emptyParagraphOf,
  isDerivedEmpty,
  type NodeRule,
  type RoomDocs,
  removedOnPath,
  replaceText,
  restore,
  STRUCTURE_KEY,
  StructureView,
  structureValues,
  visibleComments,
} from "@meridian/document-model";
import type { Fragment, Node, Slice } from "prosemirror-model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import {
  blockOf,
  inlineOf,
  type ProseMirrorSince,
  readProseMirror,
  writeProseMirror,
} from "./codec.js";
import { attachCompositionHold, listenToImports } from "./composition-hold.js";
import { resolveCursor, type SelectionCursors, selectionCursors, textblockOf } from "./cursors.js";
import { UNTRACKED_ORIGIN, type UndoHistory } from "./history.js";
import { movedPieces } from "./pieces.js";

export const loroSyncKey = new PluginKey<LoroSyncState>("loro-sync");

export interface LoroSyncOptions {
  /** The copy the editor shows and writes: a Live copy, or a draft's fork (writes go to overrides). */
  docs: RoomDocs;
  /** The commit origin of the editor's tracked writes (default `editor`). */
  origin?: string;
  /** A transaction's commit message; none is the writer's own typing (design §5's attribution). */
  messageOf?: (tr: Transaction) => string | undefined;
  /** A fresh block id, for the empty paragraph a local transaction is the first write into. */
  newBlockId: () => BlockId;
  /** Every local write's doc changes with their frontiers: what the copy publishes. */
  onLocalWrite?: (changes: DocChange[]) => void;
  /**
   * The copy's Ctrl+Z, which records every write but one marked `addToHistory: false`; that one
   * commits under `UNTRACKED_ORIGIN` and closes the open step.
   */
  history?: UndoHistory;
}

export interface LoroSyncState {
  docs: RoomDocs;
  /**
   * Removed blocks the editor still shows because the selection's head is in them (design §1,
   * "The caret rule"): a peer removed them, and the writer has not acted in them or moved away.
   */
  kept: ReadonlySet<BlockId>;
}

/** Meta on the transactions the binding dispatches itself (a peer's batch): never written back. */
export const REMOTE_META = "remote";
/** Meta on a remote transaction: the blocks its read kept. */
const KEPT_META = "loro-kept";
/** Meta on a local transaction: each placeholder id it stored, with the fresh id it took. */
const STORED_META = "loro-stored";
const NONE: ReadonlySet<BlockId> = new Set();

/**
 * The binding's ProseMirror plugin (design §6). The editor's state must start as the docs read
 * (`readProseMirror`); from then on, between transactions, the editor's document is the docs'
 * read plus the blocks it keeps (`LoroSyncState.kept`, read with `readProseMirror`'s `kept`), and
 * every read and write the binding makes passes them.
 *
 * Teardown order: destroy the `EditorView` before freeing its `RoomDocs`. Destroying the view
 * releases batches held for a composition into docs still alive; a batch held for docs already
 * freed is dropped.
 *
 * Local: a transaction that is one text replace inside one textblock (typing, Backspace, IME
 * commits) splices that block's text doc directly; any other change writes the document through
 * `writeDocument`, which pairs blocks by id and compares only the blocks the transaction made new
 * (ProseMirror shares every node a transaction left alone). Remote: a batch imported through
 * `importRemoteUpdate` re-reads only the docs it changed, keeps every other node as it is, and
 * replaces only the range that differs, with the selection carried as Loro cursors taken before
 * the import.
 *
 * The caret rule (design §1): when a peer's batch removes the block holding the selection's head,
 * or a block above it, the editor keeps every removed block on that path. A local transaction
 * with a step in a kept block restores them all before it writes; any other write leaves them
 * removed. The head leaving a kept block ends it, and the block goes from the screen.
 *
 * The empty paragraph an empty container shows (`<container>/empty`) is a placeholder no block is
 * stored under (design §1). A local transaction that leaves a node with such an id anywhere but as
 * its parent's one empty paragraph (typing into it, Enter, a retype, an unwrap moving it out)
 * gives that node a fresh id in the same transaction, before the write; either order of this
 * filter and the editor's block-id fixer holds, since the fixer never gives a placeholder id. Typing
 * into the placeholder stays typing for the history (`typingOf`'s `stores`): the write stores the
 * paragraph, and the burst it starts is one Undo step.
 */
export function loroSyncPlugin(options: LoroSyncOptions): Plugin<LoroSyncState> {
  const { docs, history } = options;
  const tracked = options.origin ?? "editor";
  return new Plugin<LoroSyncState>({
    key: loroSyncKey,
    filterTransaction(tr) {
      if (tr.docChanged && tr.getMeta(loroSyncKey) !== REMOTE_META)
        storePlaceholders(tr, options.newBlockId);
      return true;
    },
    state: {
      init: () => ({ docs, kept: NONE }),
      apply(tr, value, oldState, newState) {
        if (tr.getMeta(loroSyncKey) === REMOTE_META) {
          const kept = tr.getMeta(KEPT_META) as ReadonlySet<BlockId> | undefined;
          return kept === undefined || kept === value.kept ? value : { docs, kept };
        }
        let { kept } = value;
        if (tr.docChanged) {
          if (kept.size > 0 && touchesKept(tr, kept)) {
            // The writer acts in a block a peer removed: it comes back first, and is then an
            // ordinary block (design §1, rule 2).
            const restored = restore(docs, kept);
            if (restored) options.onLocalWrite?.([restored]);
            kept = NONE;
          }
          const message = options.messageOf?.(tr);
          const recorded = tr.getMeta("addToHistory") !== false;
          const typing = typingOf(docs, oldState, newState, tr);
          // Typing into an empty paragraph stores it: typing for the history, a full write.
          const fast = typing && !typing.stores ? typing : null;
          // One read of the structure, if anything takes it, serves the history and the write.
          let view: StructureView | undefined;
          const read = () => {
            view ??= new StructureView(docs, kept);
            return view;
          };
          // Typing joins the open Undo step; any other write starts one (design §2).
          if (recorded)
            history?.beforeWrite(
              oldState,
              { joins: typing !== null, structure: fast === null },
              kept.size === 0 ? read : undefined,
            );
          else history?.endStep();
          const origin = recorded ? tracked : UNTRACKED_ORIGIN;
          const changes = fast
            ? writeTyping(docs, fast, origin, message)
            : writeProseMirror(docs, newState.doc, {
                origin,
                message,
                previous: oldState.doc,
                kept,
                view,
                pieces: docs.draft ? movedPieces(tr) : undefined,
              });
          if (recorded) history?.record(changes);
          if (changes.length > 0) options.onLocalWrite?.(changes);
        }
        if (kept.size > 0) kept = holding(newState, kept);
        return kept === value.kept ? value : { docs, kept };
      },
    },
    // The selection left a kept block: read without it, so it goes from the screen.
    appendTransaction(trs, oldState, newState) {
      if (trs.every((tr) => tr.getMeta(loroSyncKey) === REMOTE_META)) return null;
      const was = loroSyncKey.getState(oldState)?.kept ?? NONE;
      const kept = loroSyncKey.getState(newState)?.kept ?? NONE;
      if (kept.size >= was.size) return null;
      const since = {
        doc: newState.doc,
        comments: visibleComments(docs),
        changed: new Set([STRUCTURE_KEY]),
      };
      const tr = remoteTransaction(docs, newState, selectionCursors(docs, newState), since, kept);
      return tr?.setMeta(KEPT_META, kept) ?? null;
    },
    view(view) {
      const hold = attachCompositionHold(docs, view);
      let cursors: SelectionCursors | null = null;
      let head: BlockId | null = null;
      // The comments the editor's document shows bodies of: a batch that adds or removes a body
      // changes how every block's text reads.
      let comments = visibleComments(docs);
      const unlisten = listenToImports(docs, {
        before: () => {
          cursors = selectionCursors(docs, view.state);
          const { parent } = view.state.selection.$head;
          head = parent.isTextblock && typeof parent.attrs.id === "string" ? parent.attrs.id : null;
        },
        after: (changed, remote) => {
          const since = { doc: view.state.doc, comments, changed };
          const was = loroSyncKey.getState(view.state)?.kept ?? NONE;
          let kept = was;
          if (changed.has(STRUCTURE_KEY)) {
            comments = visibleComments(docs);
            // A peer's removal on the head's path is kept; a local write (an Undo, a command)
            // keeps nothing new, and what it brought back is no longer kept.
            const path = head === null ? [] : removedOnPath(docs, head);
            const now = remote ? path : path.filter((id) => was.has(id));
            if (now.length !== was.size || now.some((id) => !was.has(id)))
              kept = now.length > 0 ? new Set(now) : NONE;
          }
          const tr =
            remoteTransaction(docs, view.state, cursors, since, kept) ??
            (kept === was
              ? null
              : view.state.tr.setMeta(loroSyncKey, REMOTE_META).setMeta("addToHistory", false));
          cursors = null;
          if (tr) view.dispatch(tr.setMeta(KEPT_META, kept));
        },
      });
      return {
        update: () => hold.update(),
        destroy: () => {
          unlisten();
          hold.destroy();
        },
      };
    },
  });
}

/** The kept blocks the selection's head is still in. */
function holding(state: EditorState, kept: ReadonlySet<BlockId>): ReadonlySet<BlockId> {
  const { $head } = state.selection;
  const path = new Set<unknown>();
  for (let depth = 1; depth <= $head.depth; depth++) path.add($head.node(depth).attrs.id);
  const still = [...kept].filter((id) => path.has(id));
  return still.length === kept.size ? kept : still.length > 0 ? new Set(still) : NONE;
}

/** Whether a step of `tr` changes anything inside a kept block. */
function touchesKept(tr: Transaction, kept: ReadonlySet<BlockId>): boolean {
  return tr.steps.some((step, i) => {
    const range = rangeOf(step);
    if (!range) return false;
    let hit = false;
    tr.docs[i].descendants((node, pos) => {
      if (hit) return false;
      if (kept.has(node.attrs.id)) {
        hit = range.from < pos + node.nodeSize && range.to > pos;
        return false;
      }
      return !node.isTextblock;
    });
    return hit;
  });
}

function rangeOf(step: Transaction["steps"][number]): { from: number; to: number } | null {
  const { from, to, pos } = step.toJSON() as { from?: number; to?: number; pos?: number };
  if (from !== undefined && to !== undefined) return { from, to };
  return pos === undefined ? null : { from: pos, to: pos + 1 };
}

/**
 * Give a fresh id to every node near what `tr` changed that holds a placeholder id but is not
 * that placeholder: its parent's one child, an empty paragraph with no attributes. Only the
 * changed ranges and one position either side are read, so the neighbour of an inserted sibling
 * is too, and typing elsewhere costs the depth of the block it types in.
 */
function storePlaceholders(tr: Transaction, newBlockId: () => BlockId): void {
  const stale = new Map<number, BlockId>();
  tr.steps.forEach((step, i) => {
    const range = rangeOf(step);
    if (!range) return;
    const after = tr.mapping.slice(i);
    const from = Math.max(0, after.map(range.from, -1) - 1);
    const to = Math.min(tr.doc.content.size, after.map(range.to, 1) + 1);
    tr.doc.nodesBetween(from, to, (node, pos, parent) => {
      const id = node.attrs.id;
      if (typeof id === "string" && emptyParagraphOf(id) !== undefined && parent) {
        const under = parent === tr.doc ? null : (parent.attrs.id as BlockId);
        if (parent.childCount !== 1 || !isDerivedEmpty(blockOf(node), under)) stale.set(pos, id);
      }
      return !node.isTextblock;
    });
  });
  if (stale.size === 0) return;
  const stored = new Map<BlockId, BlockId>();
  for (const [pos, id] of stale) {
    const fresh = newBlockId();
    stored.set(id, fresh);
    tr.setNodeAttribute(pos, "id", fresh);
  }
  tr.setMeta(STORED_META, stored);
}

/**
 * Typing: one replace step of inline content inside one textblock. `stores`: the block was an
 * empty paragraph's placeholder, which the transaction stores under `id` (`storePlaceholders`).
 */
type Typing = {
  id: string;
  rule: NodeRule;
  from: number;
  to: number;
  content: Fragment;
  stores: boolean;
};

/**
 * Typing: one replace step of inline content inside one textblock, besides the steps that store
 * placeholders. Without those it is the text fast path, written with `replaceText` into that
 * block's text doc alone (so typing inside bold is one op). Null when the transaction is not.
 */
function typingOf(
  docs: RoomDocs,
  oldState: EditorState,
  newState: EditorState,
  tr: Transaction,
): Typing | null {
  const stored = tr.getMeta(STORED_META) as ReadonlyMap<BlockId, BlockId> | undefined;
  if (tr.steps.length !== 1 + (stored?.size ?? 0)) return null;
  const step = tr.steps[0].toJSON() as { stepType?: string; from?: number; to?: number };
  if (step.stepType !== "replace" || step.from === undefined || step.to === undefined) return null;
  const slice = (tr.steps[0] as unknown as { slice: Slice }).slice;
  if (slice.openStart !== 0 || slice.openEnd !== 0) return null;
  const $from = oldState.doc.resolve(step.from);
  const $after = newState.doc.resolve(step.from);
  const block = $from.parent;
  const was = block.attrs.id;
  const rule = docs.shape.node(block.type.name);
  if (!block.isTextblock || !rule || typeof was !== "string") return null;
  const id = stored?.get(was) ?? was;
  // Any other placeholder the transaction stored makes it more than typing.
  if (stored && (stored.size !== 1 || id === was)) return null;
  if (
    step.to > $from.end() ||
    $after.parent.attrs.id !== id ||
    $after.parent.type !== block.type ||
    $after.depth !== $from.depth ||
    !sameAttrs($after.parent, block)
  )
    return null;
  const from = $from.parentOffset;
  return {
    id,
    rule,
    from,
    to: from + step.to - step.from,
    content: slice.content,
    stores: id !== was,
  };
}

function writeTyping(
  docs: RoomDocs,
  { id, rule, from, to, content }: Typing,
  origin: string,
  message: string | undefined,
): DocChange[] {
  const { doc, before } = docs.writableText(id);
  replaceText(
    doc,
    { rule, shape: docs.shape, visibleComment: commentVisibility(structureValues(docs)) },
    from,
    to,
    inlineOf(content),
  );
  doc.commit({ origin, message });
  return [{ key: id, doc, before, after: doc.frontiers() }];
}

/** Whether two nodes' attributes match, their ids aside. */
function sameAttrs(a: Node, b: Node): boolean {
  for (const key of Object.keys(a.attrs))
    if (key !== "id" && a.attrs[key] !== b.attrs[key]) return false;
  return true;
}

/**
 * The transaction that brings the editor to the docs after an import (with the blocks it keeps),
 * or null if nothing shows. The selection follows its cursors. A selected node that still stands
 * stays selected. A caret whose block went goes to that block's neighbour, the end of the one
 * before it where there is one.
 */
function remoteTransaction(
  docs: RoomDocs,
  state: EditorState,
  cursors: SelectionCursors | null,
  since: ProseMirrorSince,
  kept: ReadonlySet<BlockId>,
): Transaction | null {
  const next = readProseMirror(docs, state.schema, since, kept);
  const start = state.doc.content.findDiffStart(next.content);
  if (start === null) return null;
  const end = state.doc.content.findDiffEnd(next.content) as { a: number; b: number };
  let { a: endA, b: endB } = end;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  let tr = state.tr.replace(start, endA, next.slice(start, endB));
  if (!tr.doc.eq(next)) tr = state.tr.replaceWith(0, state.doc.content.size, next.content);
  tr.setMeta(loroSyncKey, REMOTE_META).setMeta("addToHistory", false);
  const { selection } = state;
  if (selection instanceof NodeSelection && tr.selection instanceof NodeSelection) return tr;
  const anchor = cursors?.anchor ? resolveCursor(docs, tr.doc, cursors.anchor) : null;
  const head = cursors?.head ? resolveCursor(docs, tr.doc, cursors.head) : null;
  if (anchor !== null && head !== null) {
    tr.setSelection(TextSelection.create(tr.doc, anchor, head));
    return tr;
  }
  const gone = cursors?.head ?? cursors?.anchor;
  const was = gone && textblockOf(state.doc, gone.block);
  if (gone && was && !textblockOf(tr.doc, gone.block)) {
    const at = tr.mapping.map(was.start - 1, -1);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size)), -1));
  }
  return tr;
}
