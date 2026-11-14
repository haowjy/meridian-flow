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
  /**
   * Typing the frame's delete set removes without listing it: its typist is not the frame's author, and
   * the caller keeps only what a writer or an earlier recovery wrote. `LostEdits.invisible` is the
   * typist's view of the text beside it.
   */
  removed?: true;
}

export interface LostEdits {
  typed: LostEdit[];
  deleted: LostEdit[];
  /**
   * Ids already deleted in `doc` beneath the blocks the frame deletes: what the typist of a `removed`
   * edit did not see beside its words. That is the document before the frame, not the frame's delete set.
   */
  invisible: ReadonlySet<string>;
}

/**
 * What a peer update would silently lose, found before the update is applied to `doc`: incoming text
 * whose parent chain reaches a deleted item (only when `typing`: the frame is a writer's), typing the
 * frame deletes without having seen it, and deletions of items that are already deleted. Each edit
 * carries the id of the item it touched, which recovery needs to find the blocks the edits belong to.
 *
 * Ancestors the document already holds are judged by the document, however the update encodes them: a
 * full-state update carries the deleted ancestor again, apparently alive.
 *
 * Typed text is net of the update's own delete set: characters the same frame also deletes were
 * revised away by the peer (an Undo manager keeps their structs, so they still travel), and only what
 * survives in the peer's view is lost, unless the same set lists a block above the typing: then the
 * typing was deleted with its block, which the peer received after typing in it. One edit per surviving run of an incoming struct: a browser sends
 * one struct per keystroke, so recovery regroups the runs by what the peer sees side by side.
 */
export function findLostEdits(doc: Y.Doc, update: Uint8Array, typing: boolean): LostEdits {
  const out: LostEdits & { invisible: Set<string> } = {
    typed: [],
    deleted: [],
    invisible: new Set(),
  };
  const { structs, ds } = Y.decodeUpdate(update);
  const known = (id: Y.ID) => id.clock < Y.getState(doc.store, id.client);
  const incoming = structs.filter((s): s is Y.Item => s instanceof Y.Item);
  const byId = indexDecodedStructs(incoming);
  // Whether the frame's own delete set lists an ancestor of the struct being judged.
  let deletedWithin = false;
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
    if (Y.isDeleted(ds, via)) deletedWithin = true;
    if (!known(via)) {
      const inc = byId(via);
      return inc ? hidden(inc, depth + 1) : false;
    }
    const item = Y.getItem(doc.store, via) as Y.Item | Y.GC;
    // Parent given: the parent (or an ancestor) is gone. Placed by origin: the origin's parent is.
    if (p) return gone(item);
    if (!(item instanceof Y.Item)) return true;
    const owner = (item.parent as Y.AbstractType<unknown>)._item;
    return !!owner && gone(owner);
  };
  for (const s of typing ? incoming : []) {
    deletedWithin = false;
    if (!(s.content instanceof Y.ContentString) || !hidden(s)) continue;
    let run: LostEdit | null = null;
    for (let i = 0; i < s.length; i++) {
      const id = Y.createID(s.id.client, s.id.clock + i);
      // A peer that already holds the deletion lists the typing it received under the block too, so
      // with the block listed the delete set no longer says the typist revised its own words away.
      if (known(id) || (Y.isDeleted(ds, id) && !deletedWithin)) {
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
  const visited = new Set<Y.Item>();
  const unseen = (type: Y.AbstractType<unknown>) => {
    for (let item = type._start; item; item = item.right) {
      if (visited.has(item)) continue;
      visited.add(item);
      if (item.content instanceof Y.ContentType) {
        if (!item.deleted) unseen(item.content.type as Y.AbstractType<unknown>);
        continue;
      }
      if (!(item.content instanceof Y.ContentString)) continue;
      let run: LostEdit | null = null;
      for (let i = 0; i < item.length; i++) {
        const id = Y.createID(item.id.client, item.id.clock + i);
        if (item.deleted) out.invisible.add(keyOf(id));
        if (item.deleted || Y.isDeleted(ds, id)) {
          run = null;
          continue;
        }
        if (!run) {
          run = { id, text: "", removed: true };
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
          unseen(item.content.type as Y.AbstractType<unknown>);
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
