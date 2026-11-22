import {
  commentVisibility,
  type DocChange,
  emptyParagraphId,
  type RoomDocs,
  replaceText,
  STRUCTURE_KEY,
  shownUnits,
  structureValues,
  TEXT_KEY,
  textUnits,
  visibleComments,
} from "@meridian/document-model";
import type { Cursor } from "loro-crdt";
import type { Node, ResolvedPos, Slice } from "prosemirror-model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { inlineOf, type ProseMirrorSince, readProseMirror, writeProseMirror } from "./codec.js";
import { attachCompositionHold, listenToImports } from "./composition-hold.js";

export const loroSyncKey = new PluginKey<LoroSyncState>("loro-sync");

export interface LoroSyncOptions {
  /** The copy the editor shows and writes: a Live copy, or a draft's fork (writes go to overrides). */
  docs: RoomDocs;
  /** The commit origin of the editor's writes (default `editor`). */
  origin?: string;
  /** A transaction's commit message; none is the writer's own typing (design §5's attribution). */
  messageOf?: (tr: Transaction) => string | undefined;
  /** Every local write's doc changes with their frontiers: what the editor's Ctrl+Z records. */
  onLocalWrite?: (changes: DocChange[], tr: Transaction) => void;
}

export interface LoroSyncState {
  docs: RoomDocs;
}

/** Meta on the transactions the binding dispatches itself (a peer's batch): never written back. */
export const REMOTE_META = "remote";

/**
 * The binding's ProseMirror plugin (design §6). The editor's state must start as the docs read
 * (`readProseMirror`); from then on, between transactions, the editor's document is what the docs
 * read as.
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
 */
export function loroSyncPlugin(options: LoroSyncOptions): Plugin<LoroSyncState> {
  const { docs } = options;
  const origin = options.origin ?? "editor";
  return new Plugin<LoroSyncState>({
    key: loroSyncKey,
    state: {
      init: () => ({ docs }),
      apply(tr, value, oldState, newState) {
        if (!tr.docChanged || tr.getMeta(loroSyncKey) === REMOTE_META) return value;
        const message = options.messageOf?.(tr);
        const changes =
          typingWrite(docs, oldState, newState, tr, origin, message) ??
          writeProseMirror(docs, newState.doc, { origin, message, previous: oldState.doc });
        if (changes.length > 0) options.onLocalWrite?.(changes, tr);
        return value;
      },
    },
    view(view) {
      const hold = attachCompositionHold(docs, view);
      let cursors: SelectionCursors | null = null;
      // The comments the editor's document shows bodies of: a batch that adds or removes a body
      // changes how every block's text reads.
      let comments = visibleComments(docs);
      const unlisten = listenToImports(docs, {
        before: () => {
          cursors = takeCursors(docs, view.state);
        },
        after: (changed) => {
          const since = { doc: view.state.doc, comments, changed };
          if (changed.has(STRUCTURE_KEY)) comments = visibleComments(docs);
          const tr = remoteTransaction(docs, view.state, cursors, since);
          cursors = null;
          if (tr) view.dispatch(tr);
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

/**
 * The text fast path: one replace step of inline content inside one textblock, written with
 * `replaceText` into that block's text doc alone (so typing inside bold is one op). Returns null to
 * fall back to the full write.
 */
function typingWrite(
  docs: RoomDocs,
  oldState: EditorState,
  newState: EditorState,
  tr: Transaction,
  origin: string,
  message: string | undefined,
): DocChange[] | null {
  if (tr.steps.length !== 1) return null;
  const step = tr.steps[0].toJSON() as { stepType?: string; from?: number; to?: number };
  if (step.stepType !== "replace" || step.from === undefined || step.to === undefined) return null;
  const slice = (tr.steps[0] as unknown as { slice: Slice }).slice;
  if (slice.openStart !== 0 || slice.openEnd !== 0) return null;
  const $from = oldState.doc.resolve(step.from);
  const $after = newState.doc.resolve(step.from);
  const block = $from.parent;
  const id = block.attrs.id;
  const rule = docs.shape.node(block.type.name);
  if (
    !block.isTextblock ||
    !rule ||
    typeof id !== "string" ||
    id.endsWith(emptyParagraphId("")) ||
    step.to > $from.end() ||
    $after.parent.attrs.id !== id ||
    $after.parent.type !== block.type ||
    $after.depth !== $from.depth ||
    !sameAttrs($after.parent, block)
  )
    return null;
  const { doc, before } = docs.writableText(id);
  const from = $from.parentOffset;
  replaceText(
    doc,
    { rule, shape: docs.shape, visibleComment: commentVisibility(structureValues(docs)) },
    from,
    from + step.to - step.from,
    inlineOf(slice.content),
  );
  doc.commit({ origin, message });
  return [{ key: id, doc, before, after: doc.frontiers() }];
}

function sameAttrs(a: Node, b: Node): boolean {
  for (const key of Object.keys(a.attrs)) if (a.attrs[key] !== b.attrs[key]) return false;
  return true;
}

/** A place in a textblock as a Loro cursor in the block's text doc, which survives anyone's edits. */
export interface DocCursor {
  block: string;
  cursor: Cursor;
  /** The cursor holds the unit before a caret, which is one past it. */
  after: boolean;
}
interface SelectionCursors {
  anchor: DocCursor | null;
  head: DocCursor | null;
}

/** The cursor at `$pos`, when it is inside a textblock the docs hold. */
export function cursorAt(docs: RoomDocs, $pos: ResolvedPos): DocCursor | null {
  const block = $pos.parent;
  const id = block.attrs.id;
  if (!block.isTextblock || typeof id !== "string") return null;
  const doc = docs.textOf(id);
  const rule = docs.shape.node(block.type.name);
  if (!doc || !rule) return null;
  const units = shownUnits(doc, rule, docs.shape);
  const offset = $pos.parentOffset;
  const unit = units[offset > 0 ? offset - 1 : offset];
  const cursor = doc.getText(TEXT_KEY).getCursor(unit ? unit.pos : 0);
  return cursor ? { block: id, cursor, after: offset > 0 && unit !== undefined } : null;
}

/** The selection's ends as cursors in their blocks' text docs, taken while editor and docs agree. */
function takeCursors(docs: RoomDocs, state: EditorState): SelectionCursors {
  const { selection } = state;
  return { anchor: cursorAt(docs, selection.$anchor), head: cursorAt(docs, selection.$head) };
}

/** Where the textblock `id` starts in `doc`, and the block. */
function textblockOf(doc: Node, id: string): { node: Node; start: number } | null {
  let found: { node: Node; start: number } | null = null;
  doc.descendants((child, pos) => {
    if (found) return false;
    if (child.isTextblock && child.attrs.id === id) {
      found = { node: child, start: pos + 1 };
      return false;
    }
    return !child.isTextblock;
  });
  return found;
}

/**
 * The transaction that brings the editor to the docs after an import, or null if nothing shows.
 * The selection follows its cursors. A selected node that still stands stays selected. A caret
 * whose block a peer removed goes to that block's neighbour, the end of the one before it where
 * there is one: typing composed into the removed block stays in its text doc, hidden with it.
 */
function remoteTransaction(
  docs: RoomDocs,
  state: EditorState,
  cursors: SelectionCursors | null,
  since: ProseMirrorSince,
): Transaction | null {
  const next = readProseMirror(docs, state.schema, since);
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

/**
 * The editor position a cursor stands at now, if its block still shows. A cursor whose held unit
 * was deleted stands where the unit was, so the caret that followed the unit is there too.
 */
export function resolveCursor(docs: RoomDocs, doc: Node, at: DocCursor): number | null {
  const text = docs.textOf(at.block);
  const found = text && textblockOf(doc, at.block);
  const rule = found && docs.shape.node(found.node.type.name);
  if (!text || !found || !rule) return null;
  const position = text.getCursorPos(at.cursor);
  if (!position) return null;
  let shown = 0;
  for (const unit of textUnits(text, rule, docs.shape)) {
    if (unit.pos >= position.offset) break;
    if (!unit.hidden) shown++;
  }
  const held = at.after && position.update === undefined;
  return found.start + Math.min(shown + (held ? 1 : 0), found.node.content.size);
}
