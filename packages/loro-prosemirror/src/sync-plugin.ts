import {
  type DocChange,
  type DocKey,
  emptyParagraphId,
  markNameOf,
  type RoomDocs,
  sameValue,
  TEXT_KEY,
  textUnits,
} from "@meridian/document-model";
import type { Cursor } from "loro-crdt";
import type { Node, ResolvedPos } from "prosemirror-model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { readProseMirror, shapeSchemaOf, storedMarks, writeProseMirror } from "./codec.js";
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
 * Local: a transaction that is one text replace inside one textblock (typing, Backspace, IME
 * commits) splices that block's text doc directly; any other change writes the document through
 * `writeDocument`, which pairs blocks by id and writes only what differs. Remote: a batch imported
 * through `importRemoteUpdate` re-reads the docs and replaces only the range that differs, with the
 * selection carried as Loro cursors taken before the import.
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
          writeProseMirror(docs, newState.doc, { origin, message });
        if (changes.length > 0) options.onLocalWrite?.(changes, tr);
        return value;
      },
    },
    view(view) {
      const hold = attachCompositionHold(docs, view);
      let cursors: SelectionCursors | null = null;
      const unlisten = listenToImports(docs, {
        before: () => {
          cursors = takeCursors(docs, view.state);
        },
        after: (changed) => {
          const tr = remoteTransaction(docs, view.state, cursors, changed);
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
 * The text fast path: one replace step of plain text inside one textblock whose text doc holds
 * exactly the editor's units. One splice of one `LoroText`, then clearing any style the insert
 * took from a neighbour the editor's text does not carry. Returns null to fall back to the full
 * write.
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
  const slice = (
    tr.steps[0] as unknown as {
      slice: { openStart: number; openEnd: number; content: { content: readonly Node[] } };
    }
  ).slice;
  if (slice.openStart !== 0 || slice.openEnd !== 0) return null;
  const inserted = slice.content.content;
  if (inserted.some((node) => !node.isText)) return null;
  const $from = oldState.doc.resolve(step.from);
  const $after = newState.doc.resolve(step.from);
  const block = $from.parent;
  const id = block.attrs.id;
  if (
    !block.isTextblock ||
    typeof id !== "string" ||
    id.endsWith(emptyParagraphId("")) ||
    step.to > $from.end() ||
    $after.parent.attrs.id !== id ||
    $after.parent.type !== block.type ||
    $after.depth !== $from.depth ||
    !sameAttrs($after.parent, block)
  )
    return null;
  const existing = docs.textOf(id);
  const length = existing ? existing.getText(TEXT_KEY).length : 0;
  if (length !== block.content.size) return null;
  const { doc, before } = docs.writableText(id);
  const text = doc.getText(TEXT_KEY);
  const from = $from.parentOffset;
  const to = from + step.to - step.from;
  if (to > from) text.delete(from, to - from);
  // Loro styles an insert with a mark that covers both sides of it, or that ends beside it and
  // expands that way; mark and unmark only where that differs from the editor's text, so typing
  // inside bold writes no style op.
  const left = storedMarks($from.nodeBefore?.marks ?? []);
  const right = storedMarks(oldState.doc.resolve(step.to).nodeAfter?.marks ?? []);
  const expand = (key: string) => docs.shape.styles[markNameOf(key)]?.expand ?? "none";
  const inherited = (key: string) =>
    key in left && (key in right || expand(key) === "after" || expand(key) === "both")
      ? left[key]
      : key in right && (expand(key) === "before" || expand(key) === "both")
        ? right[key]
        : undefined;
  let at = from;
  for (const node of inserted) {
    const marks = storedMarks(node.marks);
    const length = node.text?.length ?? 0;
    text.insert(at, node.text ?? "");
    const range = { start: at, end: at + length };
    for (const [key, value] of Object.entries(marks))
      if (!sameValue(inherited(key), value)) text.mark(range, key, value as never);
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
      if (!(key in marks) && inherited(key) !== undefined) text.unmark(range, key);
    at += length;
  }
  doc.commit({ origin, message });
  return [{ key: id, doc, before, after: doc.frontiers() }];
}

function sameAttrs(a: Node, b: Node): boolean {
  for (const key of Object.keys(a.attrs)) if (a.attrs[key] !== b.attrs[key]) return false;
  return true;
}

interface DocCursor {
  block: string;
  cursor: Cursor;
  /** The cursor holds the unit before a caret, which is one past it. */
  after: boolean;
}
interface SelectionCursors {
  anchor: DocCursor | null;
  head: DocCursor | null;
}

/** The selection's ends as cursors in their blocks' text docs, taken while editor and docs agree. */
function takeCursors(docs: RoomDocs, state: EditorState): SelectionCursors {
  const one = ($pos: ResolvedPos): DocCursor | null => {
    const block = $pos.parent;
    const id = block.attrs.id;
    if (!block.isTextblock || typeof id !== "string") return null;
    const doc = docs.textOf(id);
    const rule = shapeSchemaOf(state.schema).node(block.type.name);
    if (!doc || !rule) return null;
    const units = textUnits(doc, rule, docs.shape).filter((unit) => !unit.hidden);
    const offset = $pos.parentOffset;
    const after = offset > 0;
    const unit = units[after ? offset - 1 : offset];
    const cursor = doc.getText(TEXT_KEY).getCursor(unit ? unit.pos : 0);
    return cursor ? { block: id, cursor, after: after && unit !== undefined } : null;
  };
  const { selection } = state;
  return { anchor: one(selection.$anchor), head: one(selection.$head) };
}

/** The transaction that brings the editor to the docs after an import, or null if nothing shows. */
function remoteTransaction(
  docs: RoomDocs,
  state: EditorState,
  cursors: SelectionCursors | null,
  _changed: ReadonlySet<DocKey>,
): Transaction | null {
  const next = readProseMirror(docs, state.schema);
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
  const anchor = cursors?.anchor ? resolveCursor(docs, tr.doc, cursors.anchor) : null;
  const head = cursors?.head ? resolveCursor(docs, tr.doc, cursors.head) : null;
  if (anchor !== null && head !== null) tr.setSelection(TextSelection.create(tr.doc, anchor, head));
  return tr;
}

/** The editor position a cursor stands at now, if its block still shows. */
function resolveCursor(docs: RoomDocs, doc: Node, at: DocCursor): number | null {
  const text = docs.textOf(at.block);
  if (!text) return null;
  let start = -1;
  let node: Node | null = null;
  doc.descendants((child, pos) => {
    if (start >= 0) return false;
    if (child.isTextblock && child.attrs.id === at.block) {
      start = pos + 1;
      node = child;
    }
    return !child.isTextblock;
  });
  const found = node as Node | null;
  if (start < 0 || !found) return null;
  const position = text.getCursorPos(at.cursor);
  if (!position) return null;
  const rule = docs.shape.node(found.type.name);
  if (!rule) return null;
  const units = textUnits(text, rule, docs.shape);
  let shown = 0;
  for (const unit of units) {
    if (unit.pos >= position.offset) break;
    if (!unit.hidden) shown++;
  }
  return start + Math.min(shown + (at.after ? 1 : 0), found.content.size);
}
