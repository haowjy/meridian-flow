/**
 * Late-peer detection. A peer update authored before the peer received a rebase can touch items the
 * rebase deleted: typing inside a paragraph the rebase removed or re-created (moved, retyped), or deleting
 * text the rebase already deleted and copied elsewhere (a split's tail). Yjs merges those silently: the
 * typing sits under a deleted parent, invisible, and the deletion is a no-op on the old copy.
 */
import * as Y from "yjs";
import { indexDecodedStructs } from "../yjs-mutation.js";

/** Deleted, collected, or under a deleted ancestor: the item shows nowhere in the document. */
function gone(item: Y.Item | Y.GC): boolean {
  if (!(item instanceof Y.Item)) return true; // collected: deleted long enough ago to be GC'd
  if (item.deleted) return true;
  const parent = item.parent as Y.AbstractType<unknown> | null;
  return !!parent?._item && gone(parent._item);
}

/** A lost edit with the id of the item it touched: incoming text, or an already-deleted item. */
export interface LostEdit {
  id: Y.ID;
  text: string;
}

/**
 * What a peer update would silently lose, found before the update is applied to `doc`: incoming text
 * whose parent chain reaches a deleted item, and deletions of items that are already deleted. Each edit
 * carries the id of the item it touched, which recovery needs to find the blocks the edits belong to.
 *
 * Typed text is net of the update's own delete set (D33): characters the same frame also deletes were
 * revised away by the peer (an Undo manager keeps their structs, so they still travel), and only what
 * survives in the peer's view is lost. One edit per surviving run of an incoming struct: a browser sends
 * one struct per keystroke, so recovery regroups the runs by what the peer sees side by side.
 */
export function findLostEdits(
  doc: Y.Doc,
  update: Uint8Array,
): { typed: LostEdit[]; deleted: LostEdit[] } {
  const out = { typed: [] as LostEdit[], deleted: [] as LostEdit[] };
  const { structs, ds } = Y.decodeUpdate(update);
  const known = (id: Y.ID) => id.clock < Y.getState(doc.store, id.client);
  const incoming = structs.filter((s): s is Y.Item => s instanceof Y.Item);
  const byId = indexDecodedStructs(incoming);
  const hidden = (s: Y.Item, depth = 0): boolean => {
    if (depth > 1000) return false;
    const p = s.parent as unknown;
    const via =
      p && typeof p === "object" && "client" in (p as object)
        ? (p as Y.ID)
        : !p
          ? (s.origin ?? s.rightOrigin)
          : null;
    if (!via) return false;
    const inc = byId(via);
    if (inc) return hidden(inc, depth + 1);
    if (!known(via)) return false;
    const item = Y.getItem(doc.store, via) as Y.Item | Y.GC;
    // Parent given: the parent (or an ancestor) is gone. Placed by origin: the origin's parent is.
    if (p) return gone(item);
    if (!(item instanceof Y.Item)) return true;
    const owner = (item.parent as Y.AbstractType<unknown>)._item;
    return !!owner && gone(owner);
  };
  for (const s of incoming) {
    if (!(s.content instanceof Y.ContentString) || !hidden(s)) continue;
    let run: LostEdit | null = null;
    for (let i = 0; i < s.length; i++) {
      const id = Y.createID(s.id.client, s.id.clock + i);
      if (known(id) || Y.isDeleted(ds, id)) {
        run = null;
        continue;
      }
      if (!run) {
        run = { id, text: "" };
        out.typed.push(run);
      }
      run.text += s.content.str[i];
    }
  }
  for (const [client, ranges] of ds.clients)
    for (const r of ranges)
      for (let c = r.clock; c < r.clock + r.len; c++) {
        const id = Y.createID(client, c);
        if (!known(id)) continue;
        const item = Y.getItem(doc.store, id) as Y.Item | Y.GC;
        if (gone(item)) {
          const ch =
            item instanceof Y.Item && item.content instanceof Y.ContentString
              ? item.content.str[c - item.id.clock]
              : "?";
          out.deleted.push({ id, text: ch ?? "?" });
        }
      }
  return out;
}

/**
 * After a reply's writes merged into `doc`: the text each write inserted that shows nowhere, because the
 * writer discarded or deleted it meanwhile. One string per write (each a list of its update segments).
 * Text the same reply deleted itself is not lost, only revised.
 */
export function invisibleInsertions(
  doc: Y.Doc,
  writes: readonly (readonly Uint8Array[])[],
): string[] {
  const decoded = writes.map((segments) => segments.map((update) => Y.decodeUpdate(update)));
  const revised = new Set<string>();
  for (const write of decoded)
    for (const { ds } of write)
      for (const [client, ranges] of ds.clients)
        for (const r of ranges)
          for (let c = r.clock; c < r.clock + r.len; c++) revised.add(`${client}:${c}`);
  return decoded.map((write) => {
    let text = "";
    for (const { structs } of write)
      for (const s of structs) {
        if (!(s instanceof Y.Item) || !(s.content instanceof Y.ContentString)) continue;
        for (let i = 0; i < s.length; i++) {
          const id = Y.createID(s.id.client, s.id.clock + i);
          if (
            revised.has(`${id.client}:${id.clock}`) ||
            id.clock >= Y.getState(doc.store, id.client)
          )
            continue;
          if (gone(Y.getItem(doc.store, id))) text += s.content.str[i];
        }
      }
    return text;
  });
}
