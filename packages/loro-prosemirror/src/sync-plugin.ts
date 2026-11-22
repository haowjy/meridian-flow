import {
  commentVisibility,
  type DocChange,
  emptyParagraphId,
  type RoomDocs,
  replaceText,
  revivedBlock,
  STRUCTURE_KEY,
  structureValues,
  visibleComments,
} from "@meridian/document-model";
import { Fragment, type Node, type Slice } from "prosemirror-model";
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
import {
  type DocCursor,
  offsetOfCursor,
  resolveCursor,
  type SelectionCursors,
  selectionCursors,
  textblockOf,
} from "./cursors.js";
import { UNTRACKED_ORIGIN, type UndoHistory } from "./history.js";

export const loroSyncKey = new PluginKey<LoroSyncState>("loro-sync");

export interface LoroSyncOptions {
  /** The copy the editor shows and writes: a Live copy, or a draft's fork (writes go to overrides). */
  docs: RoomDocs;
  /** The commit origin of the editor's tracked writes (default `editor`). */
  origin?: string;
  /** A transaction's commit message; none is the writer's own typing (design §5's attribution). */
  messageOf?: (tr: Transaction) => string | undefined;
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
}

/** The caret of a writer whose block a peer's removal just hid, left at the end of the block before. */
interface Parked {
  block: string;
  /** The hidden block's node type, to read its text. */
  node: string;
  /** Where the caret stood in the hidden block. */
  at: DocCursor;
  /** Where the editor's caret is now, which the typing must still find it at. */
  head: number;
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
  const { docs, history } = options;
  const tracked = options.origin ?? "editor";
  let parked: Parked | null = null;
  return new Plugin<LoroSyncState>({
    key: loroSyncKey,
    props: {
      // The writer's next keys after a peer removed their block go into that block, which they
      // bring back (design §1, "Removed blocks"), until the caret moves.
      handleTextInput(view, from, to, text) {
        const at = parked;
        if (!at || from !== to || from !== at.head || !view.state.selection.empty) return false;
        const rule = docs.shape.node(at.node);
        const offset = rule ? offsetOfCursor(docs, rule, at.at) : null;
        if (!rule || offset === null) return false;
        parked = null;
        history?.beforeWrite(view.state);
        const { doc, before } = docs.writableText(at.block);
        replaceText(
          doc,
          { rule, shape: docs.shape, visibleComment: commentVisibility(structureValues(docs)) },
          offset,
          offset,
          inlineOf(Fragment.from(view.state.schema.text(text))),
        );
        doc.commit({ origin: tracked });
        const changes = [{ key: at.block, doc, before, after: doc.frontiers() }];
        history?.record(changes);
        options.onLocalWrite?.(changes);
        const since = {
          doc: view.state.doc,
          comments: visibleComments(docs),
          changed: new Set([at.block]),
        };
        const next = remoteTransaction(docs, view.state, null, since);
        const shown = next && textblockOf(next.tr.doc, at.block);
        if (next && shown)
          view.dispatch(
            next.tr.setSelection(
              TextSelection.create(next.tr.doc, shown.start + offset + text.length),
            ),
          );
        return true;
      },
    },
    state: {
      init: () => ({ docs }),
      apply(tr, value, oldState, newState) {
        if (tr.getMeta(loroSyncKey) !== REMOTE_META && (tr.docChanged || tr.selectionSet))
          parked = null;
        if (!tr.docChanged || tr.getMeta(loroSyncKey) === REMOTE_META) return value;
        const message = options.messageOf?.(tr);
        const recorded = tr.getMeta("addToHistory") !== false;
        if (recorded) history?.beforeWrite(oldState);
        else history?.endStep();
        const origin = recorded ? tracked : UNTRACKED_ORIGIN;
        const changes =
          typingWrite(docs, oldState, newState, tr, origin, message) ??
          writeProseMirror(docs, newState.doc, { origin, message, previous: oldState.doc });
        if (recorded) history?.record(changes);
        if (changes.length > 0) options.onLocalWrite?.(changes);
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
          cursors = selectionCursors(docs, view.state);
        },
        after: (changed) => {
          const since = { doc: view.state.doc, comments, changed };
          if (changed.has(STRUCTURE_KEY)) comments = visibleComments(docs);
          const next = remoteTransaction(docs, view.state, cursors, since);
          cursors = null;
          if (next) view.dispatch(next.tr);
          // A peer's batch that moves the caret on (or removes the block again) ends the parking.
          if (next?.parked) parked = next.parked;
          else if (parked && next) {
            parked.head = next.tr.mapping.map(parked.head);
            if (view.state.selection.head !== parked.head) parked = null;
          }
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
  // A write into a block shown by revival stores its key, which the full write does.
  for (let depth = 1; depth <= $from.depth; depth++)
    if (revivedBlock(docs, $from.node(depth).attrs.id)) return null;
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

/**
 * The transaction that brings the editor to the docs after an import, or null if nothing shows.
 * The selection follows its cursors. A selected node that still stands stays selected. A caret
 * whose block a peer removed goes to that block's neighbour, the end of the one before it where
 * there is one, and is `parked`: the writer's next typed text goes into the removed block and
 * brings it back. A block the writer typed into before the removal arrived does not go: the
 * removal did not read that typing, so the block reads as revived (design §1, "Removed blocks").
 */
function remoteTransaction(
  docs: RoomDocs,
  state: EditorState,
  cursors: SelectionCursors | null,
  since: ProseMirrorSince,
): { tr: Transaction; parked: Parked | null } | null {
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
  if (selection instanceof NodeSelection && tr.selection instanceof NodeSelection)
    return { tr, parked: null };
  const anchor = cursors?.anchor ? resolveCursor(docs, tr.doc, cursors.anchor) : null;
  const head = cursors?.head ? resolveCursor(docs, tr.doc, cursors.head) : null;
  if (anchor !== null && head !== null) {
    tr.setSelection(TextSelection.create(tr.doc, anchor, head));
    return { tr, parked: null };
  }
  const gone = cursors?.head ?? cursors?.anchor;
  const was = gone && textblockOf(state.doc, gone.block);
  if (gone && was && !textblockOf(tr.doc, gone.block)) {
    const at = tr.mapping.map(was.start - 1, -1);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size)), -1));
    const alone = selection.empty && cursors?.anchor?.block === gone.block;
    return {
      tr,
      parked: alone
        ? { block: gone.block, node: was.node.type.name, at: gone, head: tr.selection.head }
        : null,
    };
  }
  return { tr, parked: null };
}
