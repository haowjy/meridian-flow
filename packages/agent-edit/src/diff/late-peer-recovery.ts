/**
 * Late-peer recovery (spec-content-rebase "Late peers"). A peer update authored before the peer got a
 * rebase can type into, or delete from, top-level blocks the rebase deleted or retyped; Yjs merges that
 * into dead state (`late-peer.ts` detects it). This replays each affected block as a paragraph-level
 * rebase and writes the result into the draft, so the typing comes back green: the draft wins.
 *
 * The block "as the peer saw it" is rebuilt from an exact causal cut (`rebase-cuts.ts`, stored beside the
 * document, never in it): the latest recorded state at which every item the peer touched was still alive, plus the peer's own earlier items.
 * `rebase(old block, its current version or nothing, old block plus the peer's edit)` then merges the
 * peer's change into whatever the rebase left. A peer that deleted the whole block merges as an empty
 * side. The merge is checked before anything is written: no word may appear that neither the current
 * text nor the peer's text holds, none may repeat beyond the larger of the two, and typed text must be
 * present. A group that fails the check, or has no cut to rebuild from, is reported unplaced. Its typed words
 * are the writer's own, so they are never dropped: they go in as their own paragraph right after the
 * nearest surviving block that stood before them (D21). Deleted text that cannot be placed stays log-only.
 * Pure: it needs the doc, the update and a snapshot of the doc before the update.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { blocksEqual } from "./equal.js";
import { readBlocks } from "./fragments.js";
import type { LostEdit } from "./late-peer.js";
import { rebase } from "./merge.js";
import { decodeRebaseCuts } from "./rebase-cuts.js";
import { blockWords, similarity } from "./tokens.js";
import { writeBlocks } from "./writer.js";

/** A current block counts as the rebased version of an old one when at least this share of words match. */
const SAME_BLOCK = 0.5;

export interface LateRecovery {
  /** The server-peer update that restores the edits, or null when nothing needed writing. */
  update: Uint8Array | null;
  /** The text of each recovered edit: what the peer typed, or the block text it deleted from. */
  recovered: string[];
  /** Text the recovery could not place exactly. Typed text here is also in `fallback`; deleted text is lost. */
  unplaced: string[];
  /** Typed text written as its own paragraph after the nearest surviving earlier block. */
  fallback: string[];
}

type View = { doc: Y.Doc; fragment: Y.XmlFragment };

const para = (schema: Schema, text: string) =>
  schema.nodes.paragraph.create(null, schema.text(text));

const keyOf = (id: Y.ID) => `${id.client}:${id.clock}`;

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

function viewAt(doc: Y.Doc, fragmentName: string, cut: Y.Snapshot): View {
  const view = Y.createDocFromSnapshot(doc, cut);
  return { doc: view, fragment: view.getXmlFragment(fragmentName) };
}

const elementOf = (item: Y.Item) => (item.content as Y.ContentType).type as Y.XmlElement;

/** The block `id` names in a view; null when it is absent or deleted there. */
function blockIn(view: View, schema: Schema, id: Y.ID): PMNode | null {
  const item = Y.getItem(view.doc.store, id);
  if (!(item instanceof Y.Item) || item.deleted) return null;
  const index = view.fragment.toArray().indexOf(elementOf(item));
  const blocks = readBlocks(view.fragment, schema);
  if (blocks.length !== view.fragment.length) throw new Error("the block cannot be read");
  return blocks[index] ?? null;
}

/** Whether `item` and every ancestor exist in `cut` and are not deleted there. */
function aliveAt(cut: Y.Snapshot, id: Y.ID, item: Y.Item | Y.GC | null, self: boolean): boolean {
  if (self && (id.clock >= (cut.sv.get(id.client) ?? 0) || Y.isDeleted(cut.ds, id))) return false;
  for (let at = item; at; ) {
    if (!(at instanceof Y.Item)) return false;
    if (at.id.clock >= (cut.sv.get(at.id.client) ?? 0) || Y.isDeleted(cut.ds, at.id)) return false;
    at = (at.parent as Y.AbstractType<unknown>)._item;
  }
  return true;
}

/** `cut` plus the peer's own earlier items and deletions of them: the peer saw what it wrote. */
function withAuthors(
  cut: Y.Snapshot,
  before: Y.Snapshot,
  authors: ReadonlySet<number>,
): Y.Snapshot {
  const sv = new Map(cut.sv);
  const own = Y.createDeleteSet();
  for (const client of authors) {
    sv.set(client, Math.max(sv.get(client) ?? 0, before.sv.get(client) ?? 0));
    const ranges = before.ds.clients.get(client);
    if (ranges) own.clients.set(client, ranges);
  }
  return new Y.Snapshot(Y.mergeDeleteSets([cut.ds, own]), sv);
}

const textOf = (blocks: readonly PMNode[]) => blocks.map((b) => b.textContent).join("\n");

function countIn(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

function wordCounts(blocks: readonly PMNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks)
    for (const w of blockWords(block)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return counts;
}

/**
 * Whether `merged` is what the peer's edit makes of `region`: no word that neither side holds, no word
 * more often than the larger side, and each typed chunk present more often than before.
 */
function verified(
  merged: readonly PMNode[],
  region: readonly PMNode[],
  seen: readonly PMNode[],
  typed: readonly string[],
): boolean {
  const out = wordCounts(merged);
  const a = wordCounts(region);
  const b = wordCounts(seen);
  for (const [word, n] of out) if (n > Math.max(a.get(word) ?? 0, b.get(word) ?? 0)) return false;
  const before = textOf(region);
  const after = textOf(merged);
  return typed.every((t) => !t.trim() || countIn(after, t) > countIn(before, t));
}

/**
 * Restores what the late-peer `update` lost, after it has been applied to `doc` (a clone the caller will
 * persist). `lost` is `findLostEdits` run before the apply; `before` is `Y.snapshot` of the doc before
 * the apply; `clientId` is the server-peer client the recovery writes with.
 */
export function recoverLatePeerEdits(input: {
  doc: Y.Doc;
  update: Uint8Array;
  lost: { typed: readonly LostEdit[]; deleted: readonly LostEdit[] };
  before: Y.Snapshot;
  /** The draft's stored rebase cuts, oldest first (`document_branches.rebase_cuts`). */
  cuts: readonly Uint8Array[];
  schema: Schema;
  fragmentName: string;
  clientId: number;
}): LateRecovery {
  const { doc, schema, fragmentName } = input;
  const out: LateRecovery = { update: null, recovered: [], unplaced: [], fallback: [] };
  const fragment = doc.getXmlFragment(fragmentName);
  const elements = fragment.toArray();
  const current = readBlocks(fragment, schema);
  const replace = new Map<number, PMNode[]>(); // current index -> its replacement
  const insertAfter = new Map<number, PMNode[]>(); // anchor index (-1 = start) -> blocks to add
  const attempted: Array<{ texts: string[] }> = [];

  /** The index of the nearest surviving top-level block before `item` (-1 = the start). */
  const anchorOf = (item: Y.Item | null) => {
    for (let left = item?.left ?? null; left; left = left.left)
      if (!left.deleted) return elements.indexOf(elementOf(left));
    return -1;
  };
  const addAfter = (anchor: number, block: PMNode) =>
    insertAfter.set(anchor, [...(insertAfter.get(anchor) ?? []), block]);
  /** Typed words the exact merge could not place still reach the draft; deleted ones stay log-only. */
  const unplace = (item: Y.Item | null, typed: readonly string[], deleted: readonly string[]) => {
    out.unplaced.push(...typed, ...deleted);
    const text = typed.join("");
    if (!text.trim()) return;
    out.fallback.push(text);
    addAfter(anchorOf(item), para(schema, text));
  };

  // Group the lost edits by the top-level block they belong to.
  const blocks = new Map<string, { item: Y.Item; typed: string[]; deleted: string[] }>();
  const edits: Array<{ edit: LostEdit; kind: "typed" | "deleted" }> = [];
  for (const [kind, list] of [
    ["typed", input.lost.typed],
    ["deleted", input.lost.deleted],
  ] as const)
    for (const edit of list) {
      const item = topLevelBlock(doc, fragment, edit.id);
      if (!item) {
        unplace(null, kind === "typed" ? [edit.text] : [], kind === "typed" ? [] : [edit.text]);
        continue;
      }
      const group = blocks.get(keyOf(item.id)) ?? { item, typed: [], deleted: [] };
      group[kind].push(edit.text);
      blocks.set(keyOf(item.id), group);
      edits.push({ edit, kind });
    }
  const unplaceAll = () => {
    for (const g of blocks.values()) unplace(g.item, g.typed, g.deleted);
    return finish();
  };
  if (!blocks.size) return finish();

  // The cut: the latest recorded state at which every touched item was alive, so the peer's view of each.
  const authors = new Set<number>();
  for (const s of Y.decodeUpdate(input.update).structs) authors.add(s.id.client);
  const cuts = [...decodeRebaseCuts(input.cuts), input.before].map((cut) =>
    withAuthors(cut, input.before, authors),
  );
  let at = cuts.length - 1;
  for (const { edit, kind } of edits) {
    const item = Y.getItem(doc.store, edit.id);
    if (!(item instanceof Y.Item)) return unplaceAll();
    const start = kind === "typed" ? (item.parent as Y.AbstractType<unknown>)._item : item;
    while (at >= 0 && !aliveAt(cuts[at], edit.id, start, kind === "deleted")) at--;
  }
  if (at < 0) return unplaceAll();

  if (current.length !== elements.length) return unplaceAll();

  const views: View[] = [];
  let oldView: View;
  let seenView: View;
  try {
    oldView = viewAt(doc, fragmentName, cuts[at]);
    seenView = viewAt(doc, fragmentName, cuts[at]);
    views.push(oldView, seenView);
    Y.applyUpdate(seenView.doc, input.update);
    if (seenView.doc.store.pendingStructs || seenView.doc.store.pendingDs) return unplaceAll();
  } catch {
    for (const view of views) view.doc.destroy();
    return unplaceAll();
  }

  const claimed = new Set<number>();

  for (const { item, typed, deleted } of blocks.values()) {
    const dead = item.deleted;
    try {
      const old = blockIn(oldView, schema, item.id);
      if (!old) throw new Error("the block the peer saw cannot be rebuilt");
      // The peer may have deleted the whole block: an empty side, not a failure.
      const seenBlock = blockIn(seenView, schema, item.id);
      const seen = seenBlock ? [seenBlock] : [];
      let index = dead ? -1 : elements.indexOf(elementOf(item));
      if (dead) {
        let best = SAME_BLOCK;
        current.forEach((block, i) => {
          const sim = claimed.has(i) ? 0 : similarity(old, block);
          if (sim >= best) {
            best = sim;
            index = i;
          }
        });
      }
      const texts = typed.length ? typed : deleted;
      if (index >= 0) {
        // The rebase may have split the block: take the neighbours made of its words too.
        const words = new Set(blockWords(old));
        const derived = (i: number) => {
          const w = current[i] ? blockWords(current[i]) : [];
          return !claimed.has(i) && w.length > 0 && w.every((x) => words.has(x));
        };
        let lo = index;
        let hi = index;
        while (derived(lo - 1)) lo--;
        while (derived(hi + 1)) hi++;
        const region = current.slice(lo, hi + 1);
        let merged = rebase(schema, [old], region, seen).blocks;
        // The merge never returns zero blocks: it pads with an empty paragraph, which here is the deletion.
        if (!seen.length && merged.every((b) => b.type.name === "paragraph" && !b.content.size))
          merged = [];
        if (!verified(merged, region, seen, typed)) throw new Error("the merge cannot be verified");
        for (let i = lo; i <= hi; i++) claimed.add(i);
        if (blocksEqual(merged, region)) continue;
        replace.set(lo, merged);
        for (let i = lo + 1; i <= hi; i++) replace.set(i, []);
      } else {
        // No current version: a peer that only deleted text from a dead block changes nothing visible.
        if (!typed.length || !seenBlock) continue;
        addAfter(anchorOf(item), seenBlock);
      }
      attempted.push({ texts });
    } catch {
      unplace(item, typed, deleted);
    }
  }
  for (const view of views) view.doc.destroy();
  return finish();

  function finish(): LateRecovery {
    if (!replace.size && !insertAfter.size) return out;
    return write();
  }

  function write(): LateRecovery {
    const target: PMNode[] = [...(insertAfter.get(-1) ?? [])];
    // Block indexes only line up when every element read back as a block; otherwise the words go last.
    const aligned = current.length === elements.length;
    current.forEach((block, i) => {
      target.push(...(replace.get(i) ?? [block]), ...(aligned ? (insertAfter.get(i) ?? []) : []));
    });
    if (!aligned) for (const [anchor, added] of insertAfter) if (anchor >= 0) target.push(...added);
    if (!target.length) target.push(schema.nodes.paragraph.create());
    const before = Y.encodeStateVector(doc);
    doc.clientID = input.clientId;
    doc.transact(() => writeBlocks(fragment, schema, target), "late-peer");
    out.update = Y.encodeStateAsUpdate(doc, before);
    for (const a of attempted) out.recovered.push(a.texts.join(""));
    return out;
  }
}
