/**
 * Restoration provenance: Discard write-back ranges are base; Undo links re-created items to their source.
 *
 * Yjs never undeletes. `redoItem` creates a new item at a new id with a copy of the old content and sets
 * `original.redone` to it, for every kind of item (text, element, descendant, format, map attribute). Only
 * the doc that ran the Undo holds those pointers, so `recordRestorations` copies them into a writer-writable
 * root of the draft, under an origin the UndoManagers do not track. The root syncs and persists with the
 * draft, so the server and every reload read the same links, and the classifier follows them through chains
 * (a second Discard and Undo). Nothing is inferred afterwards.
 *
 * Validation is light because the root is writable by the writer: the original must be deleted and the
 * restored range must be the same kind of content, in ids the doc has. A forged link can only relabel the
 * writer's own text in their own draft.
 */
import * as Y from "yjs";
import type { ItemRange } from "./id-index.js";

/** Three-number ranges record base write-backs; five-number tuples record Undo links. */
export const RESTORED_ROOT = "__meridian_review_restored_v1";
/** The origin of the recording transaction. No UndoManager tracks it, so a record never lands on an undo stack. */
export const RESTORED_ORIGIN = "meridian:review-restored";

/** `[client, clock, length, toClient, toClock]`: ids `client:clock..+length` restore `toClient:toClock..`. */
export type RestorationLink = readonly [
  client: number,
  clock: number,
  length: number,
  toClient: number,
  toClock: number,
];

/**
 * Record exactly the items Discard just inserted, before appending provenance consumes another clock.
 * The caller owns the transaction; its UndoManager scopes the prose fragment, not this root.
 */
export function recordWriteBack(doc: Y.Doc, startClock: number): void {
  const length = Y.getState(doc.store, doc.clientID) - startClock;
  if (length > 0)
    doc
      .getArray<ItemRange | RestorationLink>(RESTORED_ROOT)
      .push([[doc.clientID, startClock, length]]);
}

/** Copies an UndoManager's restorations into its doc as each undo or redo pops, for the manager's life. */
export function recordRestorations(history: Y.UndoManager): void {
  history.on("stack-item-popped", ({ stackItem }) => {
    const { doc } = history;
    const links: RestorationLink[] = [];
    for (const [client, ranges] of stackItem.deletions.clients) {
      for (const { clock, len } of ranges) {
        for (let k = clock; k < clock + len && Y.getState(doc.store, client) > k; ) {
          const struct = Y.getItem(doc.store, Y.createID(client, k));
          const end = Math.min(clock + len, struct.id.clock + struct.length);
          if (struct instanceof Y.Item && struct.redone)
            pushLink(links, [
              struct.redone.client,
              struct.redone.clock + (k - struct.id.clock),
              end - k,
              client,
              k,
            ]);
          k = end;
        }
      }
    }
    if (links.length)
      doc.transact(() => doc.getArray<RestorationLink>(RESTORED_ROOT).push(links), RESTORED_ORIGIN);
  });
}

/** Appends a link, extending the last one when both its sides continue it. */
function pushLink(out: RestorationLink[], link: RestorationLink) {
  const last = out[out.length - 1];
  if (
    last &&
    last[0] === link[0] &&
    last[1] + last[2] === link[1] &&
    last[3] === link[3] &&
    last[4] + last[2] === link[4]
  )
    out[out.length - 1] = [last[0], last[1], last[2] + link[2], last[3], last[4]];
  else out.push(link);
}

const kindOf = (content: Y.Item["content"]) =>
  content instanceof Y.ContentFormat
    ? `f${content.key}`
    : content instanceof Y.ContentType
      ? `t${content.type instanceof Y.XmlElement ? content.type.nodeName : content.type.constructor.name}`
      : content.constructor.name;

/** Whether the link names ids the doc has, a deleted original, and the same kind of content on both sides. */
function sound(doc: Y.Doc, [client, clock, len, toClient, toClock]: RestorationLink): boolean {
  if (!(len > 0)) return false;
  if (client === toClient && clock < toClock + len && toClock < clock + len) return false;
  const { store } = doc;
  if (Y.getState(store, client) < clock + len || Y.getState(store, toClient) < toClock + len)
    return false;
  const now = Y.getItem(store, Y.createID(client, clock));
  const was = Y.getItem(store, Y.createID(toClient, toClock));
  if (!(now instanceof Y.Item) || !(was instanceof Y.Item) || !was.deleted) return false;
  // A browser's gc drops a deleted item's content, so its kind can no longer be compared.
  return was.content instanceof Y.ContentDeleted || kindOf(was.content) === kindOf(now.content);
}

/** The draft's positive base write-backs and Undo links, validated without reading tombstone text. */
export function readRestorations(doc: Y.Doc): { base: ItemRange[]; links: RestorationLink[] } {
  const root = doc.share.get(RESTORED_ROOT);
  const out: { base: ItemRange[]; links: RestorationLink[] } = { base: [], links: [] };
  if (!root) return out;
  for (let item = (root as Y.Array<unknown>)._start; item; item = item.right) {
    if (item.deleted || !(item.content instanceof Y.ContentAny)) continue;
    for (const raw of item.content.getContent() as unknown[]) {
      if (!Array.isArray(raw) || !raw.every(Number.isSafeInteger)) continue;
      if (raw.length === 5) {
        const link = raw as unknown as RestorationLink;
        if (sound(doc, link)) out.links.push(link);
      } else if (raw.length === 3) {
        const range = raw as unknown as ItemRange;
        const [client, clock, length] = range;
        if (
          client >= 0 &&
          clock >= 0 &&
          length > 0 &&
          Y.getState(doc.store, client) >= clock + length
        )
          out.base.push(range);
      }
    }
  }
  return out;
}
