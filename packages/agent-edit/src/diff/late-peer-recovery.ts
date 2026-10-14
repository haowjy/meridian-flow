/**
 * Late-peer recovery (spec-content-rebase "Late peers", D21, D33). A peer update authored before the peer
 * got a rebase can type into top-level blocks the rebase deleted or retyped; Yjs merges that into dead
 * state (`late-peer.ts` detects it). A stale frame is not current intent, so on text a rebase changed it
 * contributes only its net surviving typing, and nothing else:
 *
 * - The typing the frame still shows (inserted minus what the same frame deletes; `findLostEdits`) is
 *   written into the draft as its own paragraph beside its last known neighbour: green in review, the
 *   writer decides. The words the rebase replaced are never revived around it.
 * - The frame's deletions of rebased text never apply (log-only): a reconnect resends the peer's whole
 *   delete set, and nothing tells that replay from a first arrival, so acting on it would erase writing.
 *
 * Pure: it needs the doc with the update applied, and the update.
 */
import type { Schema } from "prosemirror-model";
import * as Y from "yjs";
import { readBlocks } from "./fragments.js";
import type { LostEdit } from "./late-peer.js";
import { writeBlocks } from "./writer.js";

export interface LateRecovery {
  /** The server-peer update that writes the typing, or null when nothing needed writing. */
  update: Uint8Array | null;
  /** Each paragraph of the peer's typing written into the draft. */
  written: string[];
  /** Characters of rebased text the frame deleted, which stay as they are (log-only). */
  dropped: number;
}

const elementOf = (item: Y.Item) => (item.content as Y.ContentType).type as Y.XmlElement;

/** The top-level block (a child of `fragment`) an item sits in, if the doc still knows it. */
function topLevelBlock(doc: Y.Doc, fragment: Y.XmlFragment, id: Y.ID): Y.Item | null {
  let item: Y.Item | Y.GC | null = Y.getItem(doc.store, id);
  while (item instanceof Y.Item) {
    const parent = item.parent as Y.AbstractType<unknown>;
    if (parent === fragment) return item;
    item = parent._item;
  }
  return null;
}

/**
 * The typed characters inside `block`, in document order. Runs the peer saw side by side (only text the
 * frame deleted between them) join directly; runs with other text between are joined by a space, so two
 * typed words never fuse into one the peer never saw.
 */
function typedText(block: Y.XmlElement, typed: (id: Y.ID) => boolean, ds: Y.Snapshot["ds"]) {
  let text = "";
  let gap = false;
  const visit = (type: Y.AbstractType<unknown>) => {
    for (let item = type._start; item; item = item.right) {
      if (item.content instanceof Y.ContentType) {
        if (!Y.isDeleted(ds, item.id)) gap = true;
        visit(item.content.type as Y.AbstractType<unknown>);
        continue;
      }
      if (item.content instanceof Y.ContentFormat) continue;
      const str = item.content instanceof Y.ContentString ? item.content.str : null;
      for (let i = 0; i < item.length; i++) {
        const id = Y.createID(item.id.client, item.id.clock + i);
        if (str && typed(id)) {
          if (gap && text && !/\s$/u.test(text) && !/^\s/u.test(str[i])) text += " ";
          text += str[i];
          gap = false;
        } else if (!Y.isDeleted(ds, id)) gap = true;
      }
    }
  };
  visit(block as unknown as Y.AbstractType<unknown>);
  return text.trim();
}

/**
 * Writes what the late-peer `update` lost into `doc` (the clone the caller will persist, with the update
 * already applied). `lost` is `findLostEdits` run before the apply; `clientId` is the server-peer client
 * the write uses.
 */
export function recoverLatePeerEdits(input: {
  doc: Y.Doc;
  update: Uint8Array;
  lost: { typed: readonly LostEdit[]; deleted: readonly LostEdit[] };
  schema: Schema;
  fragmentName: string;
  clientId: number;
}): LateRecovery {
  const { doc, schema } = input;
  const out: LateRecovery = { update: null, written: [], dropped: input.lost.deleted.length };
  if (!input.lost.typed.length) return out;
  const fragment = doc.getXmlFragment(input.fragmentName);
  const elements = fragment.toArray();
  const current = readBlocks(fragment, schema);
  const insertAfter = new Map<number, string[]>(); // anchor index (-1 = the start) -> paragraphs

  const typedIds = new Map<number, Array<[number, number]>>();
  for (const { id, text } of input.lost.typed)
    typedIds.set(id.client, [
      ...(typedIds.get(id.client) ?? []),
      [id.clock, id.clock + text.length],
    ]);
  const typed = (id: Y.ID) =>
    (typedIds.get(id.client) ?? []).some(([from, to]) => from <= id.clock && id.clock < to);
  const { ds } = Y.decodeUpdate(input.update);

  /** Beside its last known neighbour: after the block itself if it stands, else after the nearest survivor before it. */
  const anchorOf = (item: Y.Item) => {
    if (!item.deleted) return elements.indexOf(elementOf(item));
    for (let left = item.left; left; left = left.left)
      if (!left.deleted) return elements.indexOf(elementOf(left));
    return -1;
  };
  const add = (anchor: number, text: string) => {
    if (!text) return;
    out.written.push(text);
    insertAfter.set(anchor, [...(insertAfter.get(anchor) ?? []), text]);
  };

  const blocks = new Set<Y.Item>();
  for (const edit of input.lost.typed) {
    const item = topLevelBlock(doc, fragment, edit.id);
    if (item) blocks.add(item);
    else add(-1, edit.text.trim());
  }
  for (const item of blocks) add(anchorOf(item), typedText(elementOf(item), typed, ds));
  if (!insertAfter.size) return out;

  const para = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
  const target = (insertAfter.get(-1) ?? []).map(para);
  // Block indexes only line up when every element read back as a block; otherwise the words go last.
  const aligned = current.length === elements.length;
  current.forEach((block, i) => {
    target.push(block, ...(aligned ? (insertAfter.get(i) ?? []).map(para) : []));
  });
  if (!aligned)
    for (const [anchor, added] of insertAfter) if (anchor >= 0) target.push(...added.map(para));
  const before = Y.encodeStateVector(doc);
  doc.clientID = input.clientId;
  doc.transact(() => writeBlocks(fragment, schema, target), "late-peer");
  out.update = Y.encodeStateAsUpdate(doc, before);
  return out;
}
