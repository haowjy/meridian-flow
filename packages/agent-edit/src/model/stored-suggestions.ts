/**
 * A stored document's suggestions as a whole (`@meridian/suggestions` over a Y.Doc): who wrote
 * each change, which turns and drafts still have some, and resolving them. The browser's Apply and
 * Reject, the press and the card's Undo all resolve through `resolveStored`, so a resolve writes the
 * same Yjs operations wherever it runs.
 */

import { isLayerKey } from "@meridian/prosemirror-schema";
import {
  type Author,
  type Authors,
  accept,
  DECIDED_META,
  type DraftPending,
  type Filter,
  pendingChanges,
  pendingTurns,
  reject,
  type Verdict,
} from "@meridian/suggestions";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import * as Y from "yjs";
import { lowerResolved } from "../resolver/lower-block.js";
import type { EditRange } from "../undo/receipt.js";
import { itemsInRange } from "../yjs-mutation.js";
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
 * The map beside the fragment that records each resolve's verdicts: one key per decision,
 * `<change id>:accept` or `<change id>:reject`, so two peers resolving one change opposite ways
 * at once both stand, and each Undo takes back only its own.
 */
const VERDICTS_ROOT = "suggestion_verdicts";

/**
 * How the document's resolves decided each change, as they stand: an entry exists exactly while
 * the resolve that wrote it does (it is in every resolve's Undo scope, `resolveScope`). A change
 * nobody resolved, or whose text an edit removed, has none. Any client writes the map, so an entry
 * that is not `true` reads as none.
 */
export function suggestionVerdicts(doc: Y.Doc): { has(id: string, verdict: Verdict): boolean } {
  const map = doc.getMap<unknown>(VERDICTS_ROOT);
  return { has: (id, verdict) => map.get(`${id}:${verdict}`) === true };
}

/**
 * What a resolve writes, and so what every `Y.UndoManager` that records or takes one back must
 * hold: the fragment and the verdicts beside it. Typing never writes the verdicts.
 */
export function resolveScope(doc: Y.Doc): [Y.XmlFragment, Y.Map<unknown>] {
  return [fragmentOf(doc), doc.getMap<unknown>(VERDICTS_ROOT)];
}

/**
 * Accept or reject a stored document's suggestions, as a client of the document would. The verdict
 * only deletes text and blocks and removes marks and attributes, and it is lowered to exactly that
 * (`lowerResolved`): every Yjs item that survives stays, so text typed inside a resolved word, a
 * comment's anchor and a cursor keep their place, and a Yjs undo of it (the press's Undo, Ctrl+Z in
 * the tab) takes back only what it did, its verdicts included. Call inside one transaction;
 * returns how it decided each change it changed (empty: nothing changed).
 */
export function resolveStored(
  doc: Y.Doc,
  schema: Schema,
  verdict: Verdict,
  filter: Filter,
): ReadonlyMap<string, Verdict> {
  const state = EditorState.create({ schema, doc: storedRoot(doc, schema) });
  const tr = (verdict === "accept" ? accept : reject)(state, filter, suggestionAuthors(doc));
  const decided = (tr.getMeta(DECIDED_META) as ReadonlyMap<string, Verdict> | undefined) ?? NONE;
  if (!tr.docChanged) return decided;
  // Converting the fragment deleted the elements it cannot convert, so its children pair with the
  // root's by index.
  const applied = applyRawOps(fragmentOf(doc), lowerResolved(tr));
  if (!applied.ok) throw new Error(applied.message);
  const verdicts = doc.getMap<unknown>(VERDICTS_ROOT);
  for (const [id, fate] of decided) verdicts.set(`${id}:${fate}`, true);
  return decided;
}

const NONE: ReadonlyMap<string, Verdict> = new Map();

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
 * The drafts whose suggestions a stored document holds, each with what it has pending: the views
 * that read it otherwise than Live.
 */
export function storedPendingChanges(doc: Y.Doc, schema: Schema): Record<string, DraftPending> {
  return pendingChanges(storedRoot(doc, schema), suggestionAuthors(doc));
}

/**
 * Takes a draft's suggestions out of a stored document for good, as its owner ends: they are
 * rejected and their authors and verdicts forgotten, in one transaction with no record, since
 * nothing can take it back. Every change the draft's items carry goes, a proposal Live has since
 * matched included, which no review lists. Returns whether anything changed.
 */
export function dropDraft(doc: Y.Doc, schema: Schema, draft: string): boolean {
  let decided = NONE;
  doc.transact(() => {
    decided = resolveStored(doc, schema, "reject", { draft });
    const authors = doc.getMap<unknown>(AUTHORS_ROOT);
    const verdicts = doc.getMap<unknown>(VERDICTS_ROOT);
    for (const id of decided.keys()) {
      authors.delete(id);
      verdicts.delete(`${id}:accept`);
      verdicts.delete(`${id}:reject`);
    }
  });
  return decided.size > 0;
}

/**
 * What the writer did with the suggestions one write left, read from the changes its own items
 * carry (`EditEffect.inserted`) and their recorded verdicts: `applied` when every one was
 * accepted, `discarded` when every one was rejected, null otherwise (one is pending, an edit
 * removed it, or two resolves decided it opposite ways).
 */
export function writeVerdict(
  doc: Y.Doc,
  inserted: readonly EditRange[],
): "applied" | "discarded" | null {
  const ids = new Set<string>();
  for (const range of inserted)
    for (const { item } of itemsInRange(doc, range)) {
      const { content } = item;
      if (content instanceof Y.ContentFormat) {
        const id = markOf(content.key) ? changeId(content.value) : null;
        if (id) ids.add(id);
      } else if (item.parentSub === "sug") {
        const id = changeId(content.getContent()[0]);
        if (id) ids.add(id);
      } else if (item.parentSub && isLayerKey(item.parentSub)) {
        const id = changeId(content.getContent()[0]);
        if (id) ids.add(id);
      }
    }
  if (ids.size === 0) return null;
  const verdicts = suggestionVerdicts(doc);
  const decided = new Set<Verdict>();
  for (const id of ids) {
    const accepted = verdicts.has(id, "accept");
    if (accepted === verdicts.has(id, "reject")) return null;
    decided.add(accepted ? "accept" : "reject");
  }
  if (decided.size > 1) return null;
  return decided.has("accept") ? "applied" : "discarded";
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
  verdict: Verdict,
  filter: Filter,
): PressRecord | null {
  const origin = Symbol("press");
  const recorder = new Y.UndoManager(resolveScope(doc), {
    trackedOrigins: new Set([origin]),
    captureTimeout: Number.POSITIVE_INFINITY,
  });
  try {
    let changed = false;
    doc.transact(() => {
      changed = resolveStored(doc, schema, verdict, filter).size > 0;
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
  const undo = new Y.UndoManager(resolveScope(doc), { trackedOrigins: new Set() });
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
 * Takes out of a planning view (`createPlanningView`) the suggestions it shows that `room` records
 * as rejected, so a write that proposes one again is a new suggestion, not a match with the view.
 * A block's attribute layers share one item, which goes when every one of them was rejected.
 * Every step is a deletion of an item the room has deleted
 * or replaced too: the write planned on the view ships the view's own updates to the room, so the
 * view writes nothing new and references nothing the room lacks.
 */
export function withdrawRejected(view: Y.Doc, room: Y.Doc): void {
  const shown = suggestionItems(fragmentOf(view));
  const verdicts = suggestionVerdicts(room);
  const rejected = new Set([...shown.keys()].filter((id) => verdicts.has(id, "reject")));
  if (rejected.size === 0) return;
  const out: IdRanges = {};
  const take = ({ id, len }: ItemRun) => {
    if (!out[id.client]) out[id.client] = [];
    out[id.client]?.push([id.clock, len]);
  };
  for (const id of rejected) {
    const parts = shown.get(id);
    parts?.inserted.forEach(take);
    parts?.blocks.forEach(take);
    parts?.strikes.forEach(take);
    parts?.layers.forEach(take);
  }
  for (const runs of Object.values(out)) runs.sort((a, b) => a[0] - b[0]);
  // Undoing an insertion deletes its items: the press's Undo does the deleting.
  undoPressStored(view, { insertions: out, deletions: {} });
}

type ItemRun = { id: Y.ID; len: number };

/**
 * One change's items in a document: the text and blocks it inserted, the marks that strike text,
 * and its attribute layers (each its own element attribute, `layer-key.ts`).
 */
type ChangeItems = {
  inserted: ItemRun[];
  blocks: ItemRun[];
  strikes: ItemRun[];
  layers: ItemRun[];
};

const INSERTED = "suggest_ins";
const STRUCK = "suggest_del";

function markOf(key: string): typeof INSERTED | typeof STRUCK | null {
  return key === INSERTED || key.startsWith(`${INSERTED}--`)
    ? INSERTED
    : key === STRUCK || key.startsWith(`${STRUCK}--`)
      ? STRUCK
      : null;
}

/**
 * Every change a document's visible items carry, read from Yjs items. `withdrawRejected` deletes
 * them by id; a change to how marks, `sug` or attribute layers are stored updates this beside
 * `pendingBy` in `@meridian/suggestions`.
 */
function suggestionItems(fragment: Y.XmlFragment): Map<string, ChangeItems> {
  const changes = new Map<string, ChangeItems>();
  const of = (id: string) => {
    let parts = changes.get(id);
    if (!parts) {
      parts = { inserted: [], blocks: [], strikes: [], layers: [] };
      changes.set(id, parts);
    }
    return parts;
  };
  const walkText = (text: Y.XmlText) => {
    // The insertions open at this point of the text, by mark key.
    const open = new Map<string, string>();
    for (let item = text._start; item; item = item.right) {
      if (item.deleted) continue;
      if (item.content instanceof Y.ContentFormat) {
        const { key, value } = item.content;
        const mark = markOf(key);
        const id = mark && changeId(value);
        if (mark === STRUCK && id) of(id).strikes.push({ id: item.id, len: 1 });
        if (mark === INSERTED) {
          if (id) open.set(key, id);
          else open.delete(key);
        }
        continue;
      }
      if (item.countable)
        for (const id of open.values()) of(id).inserted.push({ id: item.id, len: item.length });
    }
  };
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (let item = parent._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const child = item.content.type;
      if (child instanceof Y.XmlText) walkText(child);
      else if (child instanceof Y.XmlElement) {
        const sug = changeId(child.getAttribute("sug"));
        if (sug) of(sug).blocks.push({ id: item.id, len: 1 });
        for (const [key, held] of child._map) {
          if (held.deleted || !isLayerKey(key)) continue;
          const id = changeId(held.content.getContent()[0]);
          if (id) of(id).layers.push({ id: held.id, len: 1 });
        }
        walk(child);
      }
    }
  };
  walk(fragment);
  return changes;
}

function changeId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
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
