/**
 * A stored document's suggestions as a whole (`@meridian/suggestions` over a Y.Doc): who wrote
 * each change, which turns and Works still have some, and resolving them. The browser's Apply and
 * Reject, the press and the card's Undo all resolve through `resolveStored`, so a resolve writes the
 * same Yjs operations wherever it runs.
 */
import {
  type Author,
  type Authors,
  accept,
  type Filter,
  pendingChanges,
  pendingTurns,
  reject,
  type WorkPending,
} from "@meridian/suggestions";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import * as Y from "yjs";
import { lowerBlock, lowerResolved, resolvedEdit } from "../resolver/lower-block.js";
import { getTopLevelXmlBlocks } from "./block-hash.js";
import { applyOps as applyRawOps, fragmentOf } from "./y-prosemirror.js";

/** The map beside the fragment that holds each change's author, by change id. */
const AUTHORS_ROOT = "suggestion_authors";

/**
 * The document's change authors. Any client writes the map, so an entry that is not an author
 * reads as none. Inside a transaction a write joins it; outside, it is a transaction of its own.
 */
export function suggestionAuthors(doc: Y.Doc): Authors {
  const map = doc.getMap<unknown>(AUTHORS_ROOT);
  return {
    get: (id) => {
      const value = map.get(id);
      return isAuthor(value) ? value : undefined;
    },
    set: (id, author) => {
      map.set(id, { chat: author.chat, turn: author.turn, by: author.by });
    },
  };
}

function isAuthor(value: unknown): value is Author {
  if (typeof value !== "object" || value === null) return false;
  const { chat, turn, by } = value as Record<string, unknown>;
  const optional = (field: unknown) => field === null || typeof field === "string";
  return typeof by === "string" && optional(chat) && optional(turn);
}

/**
 * Accept or reject a stored document's suggestions, as a client of the document would. The verdict
 * only deletes text and blocks and removes marks and attributes, and each changed block is lowered
 * to exactly that (`lowerResolved`): every Yjs item that survives stays, so text typed inside a
 * resolved word, a comment's anchor and a cursor keep their place, and a Yjs undo of it (the
 * press's Undo, Ctrl+Z in the tab) takes back only what it did. Call inside one transaction;
 * returns whether anything changed.
 */
export function resolveStored(
  doc: Y.Doc,
  schema: Schema,
  verdict: "accept" | "reject",
  filter: Filter,
): boolean {
  const root = storedRoot(doc, schema);
  const state = EditorState.create({ schema, doc: root });
  const tr = (verdict === "accept" ? accept : reject)(state, filter, suggestionAuthors(doc));
  if (!tr.docChanged) return false;
  const fragment = fragmentOf(doc);
  // Read after `storedRoot`: converting the fragment deletes the elements it cannot convert, so
  // the elements left pair with the root's children by index.
  const elements = getTopLevelXmlBlocks(doc);
  const edit = resolvedEdit(tr);
  const starts: number[] = [];
  root.forEach((_, offset) => {
    starts.push(offset);
  });
  for (let index = elements.length - 1; index >= 0; index--) {
    const before = root.child(index);
    // A removed block maps to one point; a kept one to the block it became.
    const from = tr.mapping.map(starts[index], 1);
    const to = tr.mapping.map(starts[index] + before.nodeSize, -1);
    if (to <= from) fragment.delete(fragment.toArray().indexOf(elements[index]), 1);
    else {
      const after = tr.doc.nodeAt(from) as PMNode;
      if (after.eq(before)) continue;
      const ops = lowerResolved(before, starts[index], edit) ?? lowerBlock(before, after);
      const applied = applyRawOps(elements[index], ops);
      if (!applied.ok) throw new Error(applied.message);
    }
  }
  return true;
}

/** The turns whose suggestions a stored document still holds; one read per document state. */
export function storedPendingTurns(doc: Y.Doc, schema: Schema): ReadonlySet<string> {
  let turns = pendingByDoc.get(doc);
  if (!turns) {
    turns = pendingTurns(storedRoot(doc, schema), suggestionAuthors(doc));
    pendingByDoc.set(doc, turns);
    doc.once("afterTransaction", () => pendingByDoc.delete(doc));
  }
  return turns;
}

const pendingByDoc = new WeakMap<Y.Doc, Set<string>>();

/**
 * The Works whose suggestions a stored document holds, each with what it has pending: the views
 * that read it otherwise than Live.
 */
export function storedPendingChanges(doc: Y.Doc, schema: Schema): Record<string, WorkPending> {
  return pendingChanges(storedRoot(doc, schema), suggestionAuthors(doc));
}

/** Yjs item ids by client, as `[clock, len]` runs in clock order. */
export type IdRanges = Record<string, [number, number][]>;

/** What a press's one transaction did to a stored document: all a Yjs undo of it needs. */
export type PressRecord = { insertions: IdRanges; deletions: IdRanges };

/**
 * A press's text half: `resolveStored` as one transaction of its own, and the ids that transaction
 * inserted and deleted. Null when nothing changed.
 */
export function pressStored(
  doc: Y.Doc,
  schema: Schema,
  verdict: "accept" | "reject",
  filter: Filter,
): PressRecord | null {
  const origin = Symbol("press");
  const recorder = new Y.UndoManager(fragmentOf(doc), {
    trackedOrigins: new Set([origin]),
    captureTimeout: Number.POSITIVE_INFINITY,
  });
  try {
    let changed = false;
    doc.transact(() => {
      changed = resolveStored(doc, schema, verdict, filter);
    }, origin);
    const item = recorder.undoStack[0];
    return changed && item
      ? { insertions: rangesOf(item.insertions), deletions: rangesOf(item.deletions) }
      : null;
  } finally {
    recorder.destroy();
  }
}

/**
 * Takes a press back from its record: the Yjs undo the tab's own `UndoManager` would run. Text
 * written since stays where it was written; a change whose text was removed since does not come
 * back. The document must keep deleted items (`gc: false`) and be the authority generation the
 * press ran on. Returns whether anything changed.
 */
export function undoPressStored(doc: Y.Doc, record: PressRecord): boolean {
  const undo = new Y.UndoManager(fragmentOf(doc), { trackedOrigins: new Set() });
  try {
    // Yjs 13 does not export its stack item; `undo` reads only these three fields.
    undo.undoStack.push({
      insertions: deleteSetOf(record.insertions),
      deletions: deleteSetOf(record.deletions),
      meta: new Map(),
    } as unknown as (typeof undo.undoStack)[number]);
    return undo.undo() !== null;
  } finally {
    undo.destroy();
  }
}

type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

function rangesOf(set: DeleteSet): IdRanges {
  const out: IdRanges = {};
  for (const [client, items] of set.clients)
    out[client] = items.map((item): [number, number] => [item.clock, item.len]);
  return out;
}

function deleteSetOf(ranges: IdRanges): DeleteSet {
  const set = Y.createDeleteSet();
  for (const [client, runs] of Object.entries(ranges))
    set.clients.set(
      Number(client),
      runs.map(([clock, len]) => ({ clock, len }) as never),
    );
  return set;
}

function storedRoot(doc: Y.Doc, schema: Schema): PMNode {
  return yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), schema);
}
