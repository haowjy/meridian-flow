/**
 * Late-peer detection. A peer update authored before the peer received a deletion can touch items that
 * deletion removed: typing inside a paragraph a rebase, a peer's Discard or the model deleted or
 * re-created (moved, retyped), or deleting text already deleted and copied elsewhere (a split's tail).
 * Yjs merges those silently: the typing sits under a deleted parent, invisible, and the deletion is a
 * no-op on the old copy. The other arrival order loses the same way: a delete that reaches the draft
 * after the typing removes the typing with its block, though the deleter never saw it.
 *
 * Typing the author of a deletion had not seen is exactly what Yjs shows it: an author's delete set lists
 * every item its own transaction deleted, children of a deleted block included. A writer's text that the
 * deletion removes without listing it, or that arrives under what is already deleted, was typed
 * without knowledge of the deletion.
 */
import { isReservedClientId } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { indexDecodedStructs } from "../yjs-mutation.js";

/** Deleted, collected, or under a deleted ancestor: the item shows nowhere in the document. */
function gone(item: Y.Item | Y.GC): boolean {
  if (!(item instanceof Y.Item)) return true; // collected: deleted long enough ago to be GC'd
  if (item.deleted) return true;
  const parent = item.parent as Y.AbstractType<unknown> | null;
  return !!parent?._item && gone(parent._item);
}

const keyOf = (id: Y.ID) => `${id.client}:${id.clock}`;

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
 * Typed text is net of the update's own delete set: characters the same frame also deletes were
 * revised away by the peer (an Undo manager keeps their structs, so they still travel), and only what
 * survives in the peer's view is lost. One edit per surviving run of an incoming struct: a browser sends
 * one struct per keystroke, so recovery regroups the runs by what the peer sees side by side.
 *
 * `recovered` holds the keys (`client:clock`) of paragraphs recovery wrote earlier. Their text carries the
 * server's client id, yet it is a writer's typing: a deletion of one that does not list it was made
 * without seeing the typing recovered into it since.
 */
export function findLostEdits(
  doc: Y.Doc,
  update: Uint8Array,
  recovered: ReadonlySet<string> = new Set(),
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
    if (!(s.content instanceof Y.ContentString) || isReservedClientId(s.id.client) || !hidden(s))
      continue;
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
  // Typing inside a block this update deletes, which its delete set does not list: the deleter never saw it.
  const inRecovered = (item: Y.Item | null): boolean =>
    !!item &&
    (recovered.has(keyOf(item.id)) || inRecovered((item.parent as Y.AbstractType<unknown>)._item));
  const visited = new Set<Y.Item>();
  const unseen = (type: Y.AbstractType<unknown>, rewritten: boolean) => {
    for (let item = type._start; item; item = item.right) {
      if (item.deleted || visited.has(item)) continue;
      visited.add(item);
      if (item.content instanceof Y.ContentType) {
        unseen(
          item.content.type as Y.AbstractType<unknown>,
          rewritten || recovered.has(keyOf(item.id)),
        );
        continue;
      }
      if (!(item.content instanceof Y.ContentString)) continue;
      if (!rewritten && isReservedClientId(item.id.client)) continue;
      let run: LostEdit | null = null;
      for (let i = 0; i < item.length; i++) {
        const id = Y.createID(item.id.client, item.id.clock + i);
        if (Y.isDeleted(ds, id)) {
          run = null;
          continue;
        }
        if (!run) {
          run = { id, text: "" };
          out.typed.push(run);
        }
        run.text += item.content.str[i];
      }
    }
  };
  for (const [client, ranges] of ds.clients)
    for (const r of ranges)
      for (let c = r.clock; c < r.clock + r.len; ) {
        const id = Y.createID(client, c);
        if (!known(id)) {
          c++;
          continue;
        }
        const item = Y.getItem(doc.store, id) as Y.Item | Y.GC;
        if (item instanceof Y.Item && !item.deleted && item.content instanceof Y.ContentType)
          unseen(item.content.type as Y.AbstractType<unknown>, inRecovered(item));
        c = item instanceof Y.Item ? item.id.clock + item.length : c + 1;
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
