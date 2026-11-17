/**
 * An Un-Apply hands text back from the review base to the draft as a pending change. The pull had
 * already re-created that text under new ids (Live changed it and changed it back), so the AI's
 * items are tombstones with nothing linking them to the words standing in their place. Live's
 * kernel has just certified, by item identity, that the Apply's own text stood and took it out;
 * the draft's equal text beside each tombstone is the pull's copy of it. This links the two, so
 * the card can still act on the change.
 */
import { DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import type { ApplyEntry } from "./apply-record.js";
import { readBlocks } from "./fragments.js";
import { type RestorationLink, readRestorations } from "./restorations.js";
import { diffKeys, splitWords } from "./tokens.js";

interface Char {
  client: number;
  clock: number;
}

/** The alive text next to `item`, nearest first, one entry per UTF-16 unit; only deleted items lie between. */
function standing(
  item: Y.Item,
  side: "left" | "right",
  limit: number,
): { text: string; ids: Char[] } {
  let text = "";
  const ids: Char[] = [];
  for (let next = item[side]; next && ids.length < limit; next = next[side]) {
    if (next.deleted) continue;
    if (!(next.content instanceof Y.ContentString)) break;
    const str = next.content.str;
    const order =
      side === "right" ? [...Array(str.length).keys()] : [...Array(str.length).keys()].reverse();
    for (const i of order) {
      text += str[i];
      ids.push({ client: next.id.client, clock: next.id.clock + i });
    }
  }
  return side === "right"
    ? { text, ids }
    : { text: [...text].reverse().join(""), ids: ids.reverse() };
}

/** Whether the unit at `id` sits in a word the draft shows as changed against `base`. */
function inChange(
  doc: Y.Doc,
  id: Char,
  draftBlocks: Map<unknown, PMNode>,
  baseBlocks: Map<unknown, PMNode>,
): boolean {
  const item = Y.getItem(doc.store, Y.createID(id.client, id.clock)) as Y.Item;
  let top: Y.XmlElement | undefined;
  for (
    let t: Y.AbstractType<unknown> | null = item.parent as Y.AbstractType<unknown>;
    t?._item;
    t = t._item.parent as Y.AbstractType<unknown> | null
  )
    if (t instanceof Y.XmlElement) top = t;
  if (!top) return false;
  const blockId = top.getAttribute("id");
  const draft = draftBlocks.get(blockId);
  const base = baseBlocks.get(blockId);
  if (!draft || !base) return true;
  if (draft.eq(base)) return false;
  let offset = 0;
  let found = false;
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (found) return;
      if (child instanceof Y.XmlElement) walk(child);
      else if (child instanceof Y.XmlText) {
        for (let at = child._start; at; at = at.right) {
          if (at.deleted || !(at.content instanceof Y.ContentString)) continue;
          if (
            at.id.client === id.client &&
            id.clock >= at.id.clock &&
            id.clock < at.id.clock + at.length
          ) {
            offset += id.clock - at.id.clock;
            found = true;
            return;
          }
          offset += at.length;
        }
      }
    }
  };
  walk(top);
  if (!found) return false;
  const words = splitWords(draft.textContent);
  let index = 0;
  for (let end = 0, k = 0; k < words.length; k++) {
    end += words[k].length;
    if (offset < end) {
      index = k;
      break;
    }
  }
  let to = 0;
  for (const [op, n] of diffKeys(splitWords(base.textContent), words)) {
    if (op === DIFF_EQUAL) to += n;
    else if (op === DIFF_INSERT) {
      if (index >= to && index < to + n) return true;
      to += n;
    }
  }
  return false;
}

/**
 * The links for the dead items the Apply entries name (`base`), to the equal words beside them that
 * the draft shows as a change against `base` after the take-back. Whole words, right side first.
 */
export function relinkReturned(
  doc: Y.Doc,
  schema: Schema,
  fragment: Y.XmlFragment,
  base: readonly PMNode[],
  entries: readonly ApplyEntry[],
): RestorationLink[] {
  const { links: existing } = readRestorations(doc);
  const covers = (list: readonly RestorationLink[], side: "copy" | "source", c: Char) =>
    list.find((link) => {
      const [client, clock] = side === "copy" ? [link[0], link[1]] : [link[3], link[4]];
      return client === c.client && c.clock >= clock && c.clock < clock + link[2];
    });
  const draftBlocks = new Map(readBlocks(fragment, schema).map((b) => [b.attrs.id, b]));
  const baseBlocks = new Map(base.map((b) => [b.attrs.id, b]));
  const made: RestorationLink[] = [];
  const reaches = (start: Char): boolean => {
    const seen = new Set<string>();
    for (let c: Char | undefined = start; c; ) {
      const label = `${c.client}:${c.clock}`;
      if (seen.has(label)) return false;
      seen.add(label);
      if (!(Y.getItem(doc.store, Y.createID(c.client, c.clock)) as Y.Item).deleted) return true;
      const link = covers(existing, "source", c);
      c = link && { client: link[0], clock: link[1] + (c.clock - link[4]) };
    }
    return false;
  };
  for (const entry of entries)
    for (const [client, clock, len] of entry.base)
      for (let k = clock; k < clock + len; ) {
        const item = Y.getItem(doc.store, Y.createID(client, k)) as Y.Item;
        const end = Math.min(clock + len, item.id.clock + item.length);
        const at = k;
        k = end;
        if (!item.deleted || !(item.content instanceof Y.ContentString)) continue;
        const dead = item.content.str.slice(at - item.id.clock, end - item.id.clock);
        if (reaches({ client, clock: at })) continue;
        for (const side of ["right", "left"] as const) {
          // Only the part of the item `at..end` that is next to the tombstone is compared, so a
          // split item is not mistaken for its neighbour's text.
          const next = standing(item, side, dead.length + 32);
          const tokens = splitWords(next.text);
          let sum = 0;
          let taken = 0;
          const ordered = side === "right" ? tokens : [...tokens].reverse();
          for (const token of ordered) {
            if (sum >= dead.length) break;
            sum += token.length;
            taken += token.length;
          }
          const text =
            side === "right"
              ? next.text.slice(0, taken)
              : next.text.slice(next.text.length - taken);
          if (text !== dead) continue;
          const ids =
            side === "right"
              ? next.ids.slice(0, dead.length)
              : next.ids.slice(next.ids.length - dead.length);
          if (
            ids.some((c) => covers(existing, "copy", c) || covers(made, "copy", c)) ||
            !inChange(doc, ids[0], draftBlocks, baseBlocks)
          )
            continue;
          ids.forEach((c, i) => {
            const last = made.at(-1);
            if (
              last &&
              last[0] === c.client &&
              last[1] + last[2] === c.clock &&
              last[3] === client &&
              last[4] + last[2] === at + i
            )
              made[made.length - 1] = [last[0], last[1], last[2] + 1, last[3], last[4]];
            else made.push([c.client, c.clock, 1, client, at + i]);
          });
          break;
        }
      }
  return made;
}
