import type { Frontiers } from "loro-crdt";
import { inMap } from "./handles.js";
import { frontiersOf, invertCommit, type PressCommit, pressCommit } from "./invert.js";
import { commentVisibility, readInline, textUnits } from "./read.js";
import type { Imported, RoomDocs } from "./room-docs.js";
import {
  type BlockId,
  COMMENT_STYLE_PREFIX,
  type DocKey,
  type InlineItem,
  type NodeRule,
  overrideMap,
  SENTINEL,
  STRUCTURE_KEY,
  type StructureMap,
  sameValue,
} from "./shape.js";
import { encodeRemoval, isOrderKey, removalOf, StructureView } from "./structure.js";
import {
  type DocVersion,
  docVersion,
  mergeVersion,
  type RoomVersion,
  withVector,
} from "./version.js";
import { commitStructure, type DocChange, StructureWriter } from "./write.js";

/**
 * One pending change of a draft (design §2, "The review unit is the block"): the blocks that go
 * together and the comment bodies that go with them. A press names a change by any of its members
 * and acts on all of them. A change with no blocks is a comment body some Live text carries.
 */
export interface BlockChange {
  blocks: BlockId[];
  comments: string[];
}

/** Which changes a press acts on: those naming any of these block or comment ids, or all. */
export type ChangeSelection = readonly string[] | "all";

const BLOCK_MAPS = ["parent", "order", "node", "attrs"] as const satisfies readonly StructureMap[];

/** A run of at least this many characters one block lost and the other gained makes them one change. */
const MOVED_RUN = 3;

/**
 * The pending changes of a draft copy against its `live` (design §2): a block is changed when it
 * shows on one side only, or on both with a different `parent`, `order`, `node`, attributes or
 * normalized text. Changes group: a block under an inserted or removed ancestor goes with the
 * ancestor; two changed neighbours in the merged sibling order between which text moved (a split
 * or join) are one change; a comment body only the fork's text carries goes with every shown block
 * carrying it, and a body some Live text carries is a change of its own.
 *
 * Read-only: call it on a copy already forwarded (a server room's copy is; a tab forwards in its
 * session), so another writer's Live edit is not listed as the draft's.
 */
export function changedBlocks(draft: RoomDocs): BlockChange[] {
  const live = draft.live;
  if (!live) throw new Error("changedBlocks needs a draft copy");
  const sides = { live: new Side(live), fork: new Side(draft) };
  const L = sides.live.view;
  const F = sides.fork.view;
  const changed: BlockId[] = [];
  // Hidden on both sides but written by the draft: a block the draft put inside a block it then
  // removed. It is no change of its own, but goes with that ancestor's, so discarding the removal
  // does not bring it back as a new change.
  const under: BlockId[] = [];
  for (const id of new Set([...L.ids, ...F.ids])) {
    const inLive = L.shown.has(id);
    if (inLive !== F.shown.has(id)) changed.push(id);
    else if (inLive) {
      if (blockDiffers(sides.live, sides.fork, id)) changed.push(id);
    } else if (overridesOf(F, id).length > 0) under.push(id);
  }
  const groups = new Groups(changed);
  const insertedOrRemoved = new Set(changed.filter((id) => L.shown.has(id) !== F.shown.has(id)));
  const changedAncestor = (id: BlockId, view: StructureView): BlockId | null => {
    const seen = new Set<BlockId>();
    for (let at = view.value("parent", id); typeof at === "string" && !seen.has(at); ) {
      if (insertedOrRemoved.has(at)) return at;
      seen.add(at);
      at = view.value("parent", at);
    }
    return null;
  };
  for (const id of [...changed, ...under])
    for (const view of [L, F]) {
      const at = changedAncestor(id, view);
      if (!at) continue;
      groups.add(id);
      groups.join(at, id);
      break;
    }

  const siblings = new Map<unknown, BlockId[]>();
  for (const id of new Set([...L.shown, ...F.shown])) {
    const view = F.shown.has(id) ? F : L;
    const parent = view.value("parent", id);
    const list = siblings.get(parent);
    if (list) list.push(id);
    else siblings.set(parent, [id]);
  }
  const key = (id: BlockId) => String((F.shown.has(id) ? F : L).value("order", id));
  for (const list of siblings.values()) {
    list.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
    for (let i = 0; i + 1 < list.length; i++) {
      const [a, b] = [list[i], list[i + 1]];
      if (!groups.has(a) || !groups.has(b)) continue;
      const [la, fa, lb, fb] = [
        sides.live.plain(a),
        sides.fork.plain(a),
        sides.live.plain(b),
        sides.fork.plain(b),
      ];
      if (textMoved(la, fa, lb, fb) || textMoved(lb, fb, la, fa)) groups.join(a, b);
    }
  }

  const ownBodies: string[] = [];
  const carried = new Map<string, BlockId[]>();
  for (const comment of F.overrideKeys("comments")) {
    if (sameValue(L.baseValue("comments", comment), F.override("comments", comment))) continue;
    const liveCarriers = [...L.shown].filter((id) => sides.live.carries(id, comment));
    if (liveCarriers.length > 0 && L.baseValue("comments", comment) != null) {
      ownBodies.push(comment);
      continue;
    }
    // Live has no body to show: every block holding the mark on either side reads differently
    // for the body alone, so the body goes with them.
    const carriers = [
      ...new Set([
        ...[...F.shown].filter((id) => sides.fork.carries(id, comment)),
        ...liveCarriers,
      ]),
    ];
    if (carriers.length === 0) continue;
    for (const id of carriers) groups.add(id);
    for (const id of carriers.slice(1)) groups.join(carriers[0], id);
    carried.set(comment, carriers);
  }

  const out = new Map<BlockId, BlockChange>();
  for (const id of groups.members()) {
    const root = groups.find(id);
    let change = out.get(root);
    if (!change) {
      change = { blocks: [], comments: [] };
      out.set(root, change);
    }
    change.blocks.push(id);
  }
  for (const [comment, carriers] of carried)
    out.get(groups.find(carriers[0]))?.comments.push(comment);
  return [...out.values(), ...ownBodies.map((comment) => ({ blocks: [], comments: [comment] }))];
}

/** The changes `selection` names, expanded to their whole groups. */
export function selectChanges(changes: readonly BlockChange[], selection: ChangeSelection) {
  if (selection === "all") return [...changes];
  const named = new Set(selection);
  return changes.filter((change) =>
    [...change.blocks, ...change.comments].some((id) => named.has(id)),
  );
}

/** One side's structure read and its blocks' normalized text, read once each. */
class Side {
  readonly view: StructureView;
  private readonly visible: (comment: string) => boolean;
  private readonly inlines = new Map<BlockId, InlineItem[]>();

  constructor(readonly docs: RoomDocs) {
    this.view = new StructureView(docs);
    this.visible = commentVisibility(this.view);
  }

  rule(id: BlockId): NodeRule | undefined {
    const node = this.view.node(id);
    return node === undefined ? undefined : this.docs.shape.node(node);
  }

  inline(id: BlockId): InlineItem[] {
    let items = this.inlines.get(id);
    if (!items) {
      const rule = this.rule(id);
      items = rule?.textblock
        ? readInline(this.docs.textOf(id), rule, this.docs.shape, this.visible)
        : [];
      this.inlines.set(id, items);
    }
    return items;
  }

  /** The block's text as a reader sees it, an inline node as U+FFFC; empty where it does not show. */
  plain(id: BlockId): string {
    if (!this.view.shown.has(id)) return "";
    return this.inline(id)
      .map((item) => (item.kind === "text" ? item.text : SENTINEL))
      .join("");
  }

  /**
   * Whether the block's text holds comment `comment`'s mark on a shown unit. By the stored text,
   * not the read: a block retyped to one that shows no marks (a `code_block`) still carries the
   * comment it shows again when its type goes back, and Live text keeps a mark whose body an Undo
   * took back, which a draft's body for it would show again.
   */
  carries(id: BlockId, comment: string): boolean {
    const rule = this.rule(id);
    if (!rule?.textblock) return false;
    const key = `${COMMENT_STYLE_PREFIX}${comment}`;
    return textUnits(this.docs.textOf(id), rule, this.docs.shape).some(
      (unit) => !unit.hidden && unit.stored[key] != null,
    );
  }
}

function blockDiffers(live: Side, fork: Side, id: BlockId): boolean {
  for (const name of ["parent", "order", "node"] as const)
    if (!sameValue(live.view.value(name, id), fork.view.value(name, id))) return true;
  if (!sameValue(live.view.attrs(id), fork.view.attrs(id))) return true;
  return live.rule(id)?.textblock === true && !sameValue(live.inline(id), fork.inline(id));
}

/** Whether a run of `MOVED_RUN` characters `source` lost from Live to the fork appears in what `dest` gained. */
function textMoved(sourceLive: string, sourceFork: string, destLive: string, destFork: string) {
  const lost = removedPart(sourceLive, sourceFork);
  const gained = insertedPart(destLive, destFork);
  for (let i = 0; i + MOVED_RUN <= lost.length; i++)
    if (gained.includes(lost.slice(i, i + MOVED_RUN))) return true;
  return false;
}

function commonEnds(a: string, b: string) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return { start, end };
}
const removedPart = (a: string, b: string) => {
  const { start, end } = commonEnds(a, b);
  return a.slice(start, a.length - end);
};
const insertedPart = (a: string, b: string) => {
  const { start, end } = commonEnds(a, b);
  return b.slice(start, b.length - end);
};

/** Union-find over changed block ids. */
class Groups {
  private readonly parent = new Map<BlockId, BlockId>();
  constructor(ids: Iterable<BlockId>) {
    for (const id of ids) this.parent.set(id, id);
  }
  has(id: BlockId) {
    return this.parent.has(id);
  }
  add(id: BlockId) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }
  members() {
    return [...this.parent.keys()];
  }
  find(id: BlockId): BlockId {
    const up = this.parent.get(id) as BlockId;
    if (up === id) return id;
    const root = this.find(up);
    this.parent.set(id, root);
    return root;
  }
  join(a: BlockId, b: BlockId) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/** What a press changed: the changes it acted on, and each room's changed docs, committed. */
export interface PressChanges {
  chosen: BlockChange[];
  /**
   * The press's own commits, which its Undo takes back (`undoPress`) and `press_commits` stores:
   * not the restores a forward or an import wrote on the way, which are no one's step.
   */
  commits: PressCommit[];
  /** Live's docs: commit them to the Live room first. */
  live: DocChange[];
  /** The fork's docs, including the restore a forward wrote. */
  fork: DocChange[];
}

export interface PressOptions {
  /** The commit message: `press:<commandId>`. */
  message?: string;
  /**
   * For an Apply, the Live version of each text doc the pressing tab showed (design §2): a block
   * the draft removed is removed in Live with a record of what the writer saw, capped at what this
   * copy holds, so Live typing the writer never saw brings the block back. A doc it does not name
   * counts as seen as this copy holds it.
   */
  seen?: RoomVersion;
}

/** The overrides the fork holds for block `id`, by map: what Apply copies and Discard deletes. */
function overridesOf(view: StructureView, id: BlockId): [StructureMap, string][] {
  const out: [StructureMap, string][] = [];
  for (const name of BLOCK_MAPS)
    for (const key of view.overrideKeys(name))
      if (name === "attrs" ? key.startsWith(`${id}/`) : key === id) out.push([name, key]);
  return out;
}

/** Record one of the press's own commits: sent with its room's changes and stored for its Undo. */
function own(result: PressChanges, side: PressCommit["side"], change: DocChange): void {
  result[side].push(change);
  result.commits.push(pressCommit(side, change));
}

function forwarded(draft: RoomDocs, into: DocChange[]): void {
  const imported: Imported = draft.forward();
  if (imported.restore) into.push(imported.restore);
}

/**
 * Apply (design §2, "Apply is an import"): forward, then for each chosen change set in Live the
 * value of each override the fork holds and delete the override in the fork, have Live import the
 * fork's text ops for the blocks the fork wrote (`importBatch`; a block the draft created becomes
 * Live's own doc), and copy the comment bodies the change carries. A block the draft removed is
 * removed in Live by a new record (`PressOptions.seen`), never the fork's. A selection whose
 * changes are already empty changes nothing. Both copies are committed under `message`; the fork
 * is forwarded again, so it reads as before.
 */
export function applyBlocks(
  draft: RoomDocs,
  selection: ChangeSelection,
  options: PressOptions = {},
): PressChanges {
  const live = draft.live;
  if (!live) throw new Error("applyBlocks needs a draft copy");
  const result: PressChanges = { chosen: [], commits: [], live: [], fork: [] };
  forwarded(draft, result.fork);
  result.chosen = selectChanges(changedBlocks(draft), selection);
  const blocks = result.chosen.flatMap((change) => change.blocks);
  const comments = result.chosen.flatMap((change) => change.comments);
  if (blocks.length + comments.length === 0) return result;

  const forkView = new StructureView(draft);
  const liveView = new StructureView(live);
  const liveBefore = new Map<DocKey, { at: Frontiers; version: DocVersion }>();
  const batch = new Map<DocKey, Uint8Array>();
  for (const id of blocks) {
    const text = draft.texts.get(id);
    if (!text) continue;
    const base = live.texts.get(id);
    if (base) liveBefore.set(id, { at: base.frontiers(), version: docVersion(base) });
    batch.set(
      id,
      base
        ? withVector(docVersion(base), (from) => text.export({ mode: "update", from }))
        : text.export({ mode: "update" }),
    );
  }
  if (batch.size > 0) {
    const imported = live.importBatch(batch);
    if (imported.restore) result.live.push(imported.restore);
  }
  for (const [key, { at }] of liveBefore) {
    const doc = live.texts.get(key);
    if (doc && !sameValue(at, doc.frontiers()))
      own(result, "live", { key, doc, before: at, after: doc.frontiers() });
  }

  // What the removal read of one text doc: the tab's view of Live, capped at what Live held before
  // the press, plus the draft's own ops the press brings, which every peer receiving the press
  // holds and must count as read.
  const seenOf = (key: DocKey): DocVersion => {
    const base = live.textOf(key);
    const held = liveBefore.get(key)?.version ?? (base ? docVersion(base) : new Map());
    const tab = options.seen?.get(key) ?? held;
    const out = new Map<string, number>();
    for (const [peer, counter] of tab) {
      const capped = Math.min(counter, held.get(peer) ?? 0);
      if (capped > 0) out.set(peer, capped);
    }
    const text = draft.texts.get(key);
    if (text)
      for (const [peer, counter] of docVersion(text))
        if (counter > (held.get(peer) ?? 0)) out.set(peer, counter);
    return out as DocVersion;
  };

  const liveStructure = live.structure.frontiers();
  const writer = new StructureWriter(live, liveView);
  for (const id of blocks)
    for (const [name, key] of overridesOf(forkView, id)) {
      const value = forkView.override(name, key);
      const removal = name === "order" ? removalOf(value) : null;
      if (!removal) {
        writer.set(name, key, value);
        continue;
      }
      const seen = new Map<DocKey, DocVersion>();
      for (const under of new Set([...forkView.textKeysUnder(id), ...liveView.textKeysUnder(id)]))
        if (draft.textOf(under)) seen.set(under, seenOf(under));
      const at = isOrderKey(liveView.baseValue("order", id))
        ? (liveView.baseValue("order", id) as string)
        : removal.at;
      writer.set("order", id, encodeRemoval({ at, seen }));
    }
  for (const comment of comments)
    writer.set("comments", comment, forkView.override("comments", comment) ?? null);
  const liveCommit = commitStructure(live, liveStructure, { message: options.message });
  if (liveCommit) own(result, "live", liveCommit);

  const forkStructure = draft.structure.frontiers();
  for (const id of blocks)
    for (const [name, key] of overridesOf(forkView, id))
      inMap(draft.structure, overrideMap(name), (map) => map.delete(key));
  for (const comment of comments)
    inMap(draft.structure, overrideMap("comments"), (map) => map.delete(comment));
  const forkCommit = commitStructure(draft, forkStructure, { message: options.message });
  if (forkCommit) own(result, "fork", forkCommit);
  forwarded(draft, result.fork);
  return result;
}

/**
 * Discard (design §2, "Discard is an edit in the one fork"): forward, then for each chosen change
 * delete the fork's overrides of its blocks (a block Live lacks gets `d.order` null, since it has
 * no Live value to show), have each text doc the fork wrote take Live's content as its own edit,
 * and delete the comment bodies it carries. Live is not touched; nothing is unlinked.
 */
export function discardBlocks(
  draft: RoomDocs,
  selection: ChangeSelection,
  options: Pick<PressOptions, "message"> = {},
): PressChanges {
  const live = draft.live;
  if (!live) throw new Error("discardBlocks needs a draft copy");
  const result: PressChanges = { chosen: [], commits: [], live: [], fork: [] };
  forwarded(draft, result.fork);
  result.chosen = selectChanges(changedBlocks(draft), selection);
  const blocks = result.chosen.flatMap((change) => change.blocks);
  const comments = result.chosen.flatMap((change) => change.comments);
  if (blocks.length + comments.length === 0) return result;

  const view = new StructureView(draft);
  for (const id of blocks) {
    const text = draft.texts.get(id);
    const base = live.texts.get(id);
    if (!text || !base) continue;
    const before = text.frontiers();
    text.applyDiff(text.diff(before, base.frontiers(), false));
    text.commit({ message: options.message });
    if (!sameValue(before, text.frontiers()))
      own(result, "fork", { key: id, doc: text, before, after: text.frontiers() });
  }
  const structure = draft.structure.frontiers();
  for (const id of blocks) {
    for (const [name, key] of overridesOf(view, id))
      inMap(draft.structure, overrideMap(name), (map) => map.delete(key));
    if (view.baseValue("order", id) === undefined)
      inMap(draft.structure, overrideMap("order"), (map) => map.set(id, null as never));
  }
  for (const comment of comments)
    inMap(draft.structure, overrideMap("comments"), (map) => map.delete(comment));
  const commit = commitStructure(draft, structure, { message: options.message });
  if (commit) own(result, "fork", commit);
  return result;
}

/**
 * The Undo of a press (Apply or Discard) on a draft copy, from the commits it stored (design §2):
 * forward; Live takes back its own commits (`invertCommit`); the fork, forwarded again, takes the
 * text Live's Undo removed back as its own edit, between its own frontiers either side of that
 * forward, so what the draft typed since stays and the change is pending again; then the fork takes
 * back its own commits (the overrides a press deleted, a Discard's text). Commit Live's docs first.
 */
export function undoPress(
  draft: RoomDocs,
  commits: readonly PressCommit[],
  options: Pick<PressOptions, "message"> = {},
): Pick<PressChanges, "live" | "fork"> {
  const live = draft.live;
  if (!live) throw new Error("undoPress needs a draft copy");
  const result: Pick<PressChanges, "live" | "fork"> = { live: [], fork: [] };
  forwarded(draft, result.fork);
  // Text before structure, so a removal record an inverse puts back counts the text it wrote.
  const ordered = [...commits].sort(
    (a, b) => Number(a.key === STRUCTURE_KEY) - Number(b.key === STRUCTURE_KEY),
  );
  for (const commit of ordered)
    if (commit.side === "live") {
      const change = invertCommit(live, commit.key, commit.before, commit.after, options.message);
      if (change) result.live.push(change);
    }
  const pending = new Map<DocKey, Frontiers>();
  for (const change of result.live) {
    const own = change.key === STRUCTURE_KEY ? undefined : draft.texts.get(change.key);
    if (own) pending.set(change.key, own.frontiers());
  }
  forwarded(draft, result.fork);
  for (const [key, before] of pending) {
    const doc = draft.texts.get(key);
    if (!doc) continue;
    const after = doc.frontiers();
    if (sameValue(before, after)) continue;
    doc.applyDiff(doc.diff(after, before, false));
    doc.commit({ message: options.message });
    result.fork.push({ key, doc, before: after, after: doc.frontiers() });
  }
  for (const commit of ordered)
    if (commit.side === "fork") {
      const change = invertCommit(draft, commit.key, commit.before, commit.after, options.message);
      if (change) result.fork.push(change);
    }
  return result;
}

/**
 * `Restore before` a Draft-mode turn (design §2): each doc the turn wrote goes back to where it
 * stood before the turn's first write into it, on today's Live. `before` is each doc's version as
 * the turn's first write into it began (the write's `DocChange.before`), `after` the structure's
 * version at the turn's last write. A text doc goes to `before` merged with Live's version of it,
 * so Live's edits forwarded since stay; the structure's overrides go back key by key, keeping a key
 * anyone wrote after the turn. A text doc the turn created has no `before` and is hidden by the
 * structure's restore. Returns the fork's changes, committed.
 */
export function restoreBefore(
  draft: RoomDocs,
  turn: { before: RoomVersion; after: DocVersion | null },
  options: Pick<PressOptions, "message"> = {},
): DocChange[] {
  const live = draft.live;
  if (!live) throw new Error("restoreBefore needs a draft copy");
  const out: DocChange[] = [];
  forwarded(draft, out);
  for (const [key, start] of turn.before) {
    if (key === STRUCTURE_KEY || start.size === 0) continue;
    const doc = draft.texts.get(key);
    if (!doc) continue;
    const target = new Map([[key, start]]);
    const base = live.textOf(key);
    if (base) mergeVersion(target, new Map([[key, docVersion(base)]]));
    const head = doc.frontiers();
    doc.applyDiff(doc.diff(head, frontiersOf(doc, target.get(key) as DocVersion), false));
    doc.commit({ message: options.message });
    if (!sameValue(head, doc.frontiers()))
      out.push({ key, doc, before: head, after: doc.frontiers() });
  }
  const structure = turn.before.get(STRUCTURE_KEY);
  if (structure && turn.after) {
    const change = invertCommit(draft, STRUCTURE_KEY, structure, turn.after, options.message);
    if (change) out.push(change);
  }
  return out;
}
