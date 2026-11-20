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

/**
 * Takes out of a planning view (`createPlanningView`) the suggestions rejected in `room` since the
 * view's cut, so a write that proposes one again is a new suggestion, not a match with the view.
 * The verdict is read from what each half of a change left in the room (`rejectedIn`). Every step
 * is a deletion of an item the room has deleted or superseded too, so a write planned on the view
 * references nothing the room lacks.
 */
export function withdrawRejected(view: Y.Doc, room: Y.Doc): void {
  const shown = suggestionItems(fragmentOf(view));
  if (shown.changes.size === 0) return;
  const now = suggestionItems(fragmentOf(room));
  const resolved = [...shown.changes].filter(([id]) => !now.changes.has(id));
  if (resolved.length === 0) return;
  const rejectedIn = verdicts(room, now.blocks);
  const rejected = new Set(resolved.filter(([, parts]) => rejectedIn(parts)).map(([id]) => id));
  if (rejected.size === 0) return;
  const out: IdRanges = {};
  const take = ({ id, len }: ItemRun) => {
    if (!out[id.client]) out[id.client] = [];
    out[id.client]?.push([id.clock, len]);
  };
  for (const id of rejected) {
    const parts = shown.changes.get(id);
    parts?.inserted.forEach(take);
    parts?.blocks.forEach(take);
    parts?.strikes.forEach(take);
  }
  for (const { item, ids } of shown.layers)
    if (ids.every((id) => rejected.has(id))) take({ id: item.id, len: 1 });
  for (const runs of Object.values(out)) runs.sort((a, b) => a[0] - b[0]);
  // Undoing an insertion deletes its items: the press's Undo does the deleting.
  undoPressStored(view, { insertions: out, deletions: {} });
}

/**
 * Whether a change the room no longer holds was rejected. Accept deletes struck text and reject
 * keeps it, which the writer can't undo without it reading as pending again, so struck text decides
 * when the change has any. A pure insertion is rejected when all of it is gone: an accepted one the
 * writer then deleted whole reads the same, and proposing it again is a suggestion to review. An
 * attribute layer is accepted when its block holds what it proposed, or is gone for a removal.
 */
function verdicts(room: Y.Doc, blocks: Map<string, Record<string, unknown>>) {
  const deleted = Y.createDeleteSetFromStructStore(room.store);
  const gone = ({ id, len }: ItemRun) => {
    for (let clock = id.clock; clock < id.clock + len; clock++)
      if (!Y.isDeleted(deleted, Y.createID(id.client, clock))) return false;
    return true;
  };
  return (parts: ChangeItems): boolean => {
    if (parts.struck.length > 0) return parts.struck.some((run) => !gone(run));
    const added = [...parts.inserted, ...parts.blocks];
    if (added.length > 0) return added.every(gone);
    return parts.proposed.some(({ block, attrs, remove }) => {
      const held = blocks.get(itemKey(block));
      if (!held) return false;
      return (
        remove === true || Object.entries(attrs).some(([key, value]) => !sameJson(held[key], value))
      );
    });
  };
}

type ItemRun = { id: Y.ID; len: number };

/** One change's items in a document: what it inserted, what it strikes, the marks that strike it, its attribute layers. */
type ChangeItems = {
  inserted: ItemRun[];
  blocks: ItemRun[];
  struck: ItemRun[];
  strikes: ItemRun[];
  proposed: { block: Y.ID; attrs: Record<string, unknown>; remove?: boolean }[];
};

const INSERTED = "suggest_ins";
const STRUCK = "suggest_del";

/**
 * Every change a document's visible items carry, read from Yjs items, since a resolve is told by
 * which items it deleted. Also each block's attribute layers with the item that holds them, and
 * each visible block's attributes.
 */
function suggestionItems(fragment: Y.XmlFragment): {
  changes: Map<string, ChangeItems>;
  layers: { item: Y.Item; ids: string[] }[];
  blocks: Map<string, Record<string, unknown>>;
} {
  const changes = new Map<string, ChangeItems>();
  const layers: { item: Y.Item; ids: string[] }[] = [];
  const blocks = new Map<string, Record<string, unknown>>();
  const of = (id: string) => {
    let parts = changes.get(id);
    if (!parts) {
      parts = { inserted: [], blocks: [], struck: [], strikes: [], proposed: [] };
      changes.set(id, parts);
    }
    return parts;
  };
  const markOf = (key: string) =>
    key === INSERTED || key.startsWith(`${INSERTED}--`)
      ? INSERTED
      : key === STRUCK || key.startsWith(`${STRUCK}--`)
        ? STRUCK
        : null;
  const walkText = (text: Y.XmlText) => {
    const marks = new Map<string, string>();
    for (let item = text._start; item; item = item.right) {
      if (item.deleted) continue;
      if (item.content instanceof Y.ContentFormat) {
        const { key, value } = item.content;
        const mark = markOf(key);
        if (!mark) continue;
        const id = changeId(value);
        if (id) {
          marks.set(key, id);
          if (mark === STRUCK) of(id).strikes.push({ id: item.id, len: 1 });
        } else marks.delete(key);
        continue;
      }
      if (!item.countable) continue;
      for (const [key, id] of marks)
        of(id)[markOf(key) === INSERTED ? "inserted" : "struck"].push({
          id: item.id,
          len: item.length,
        });
    }
  };
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (let item = parent._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const child = item.content.type;
      if (child instanceof Y.XmlText) walkText(child);
      else if (child instanceof Y.XmlElement) {
        const attrs = child.getAttributes() as Record<string, unknown>;
        blocks.set(itemKey(item.id), attrs);
        const sug = changeId(attrs.sug);
        if (sug) of(sug).blocks.push({ id: item.id, len: 1 });
        const held = child._map.get("sugAttrs");
        const ids: string[] = [];
        for (const layer of layersOf(attrs.sugAttrs)) {
          ids.push(layer.id);
          of(layer.id).proposed.push({ block: item.id, attrs: layer.attrs, remove: layer.remove });
        }
        if (held && !held.deleted && ids.length > 0) layers.push({ item: held, ids });
        walk(child);
      }
    }
  };
  walk(fragment);
  return { changes, layers, blocks };
}

function itemKey(id: Y.ID): string {
  return `${id.client}:${id.clock}`;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function changeId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function layersOf(
  value: unknown,
): { id: string; attrs: Record<string, unknown>; remove?: boolean }[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value as Record<string, unknown>).flatMap((layers) =>
    Array.isArray(layers)
      ? layers.flatMap((layer) => {
          const id = changeId(layer);
          if (!id) return [];
          const { attrs, remove } = layer as { attrs?: unknown; remove?: unknown };
          return [
            {
              id,
              attrs:
                typeof attrs === "object" && attrs !== null
                  ? (attrs as Record<string, unknown>)
                  : {},
              ...(remove === true ? { remove: true } : {}),
            },
          ];
        })
      : [],
  );
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
