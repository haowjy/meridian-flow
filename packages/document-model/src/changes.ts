import type { Frontiers, LoroDoc, PeerID } from "loro-crdt";
import { type CommitAuthor, commitMessage } from "./commit-message.js";
import { Groups } from "./groups.js";
import { inMap } from "./handles.js";
import { frontiersOf, loadEdit, type StoredEdit, storeEdit, takeBack } from "./invert.js";
import { deletePieces, linkedPieces, piecesOf } from "./pieces.js";
import type { Imported, RoomDocs } from "./room-docs.js";
import {
  type BlockId,
  type DocKey,
  membersOf,
  overrideMap,
  STRUCTURE_KEY,
  STRUCTURE_MAPS,
  type StructureMap,
  sameValue,
} from "./shape.js";
import { blockDiffers, Side } from "./side.js";
import { encodeRemoval, isOrderKey, removalOf, StructureView } from "./structure.js";
import {
  deletedBetween,
  type Edit,
  editStays,
  noteEdit,
  opsBetween,
  putBackValues,
  type TextSpan,
  valuesOf,
} from "./take-back.js";
import {
  type DocVersion,
  docCovers,
  docVersion,
  mergeVersion,
  plainVersion,
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

/**
 * The pending changes of a draft copy against its `live` (design §2): a block is changed when it
 * shows on one side only, or on both with a different `parent`, `order`, `node`, attributes or
 * normalized text. Changes group: a block under an inserted or removed ancestor goes with the
 * ancestor; blocks an edit moved text between (a split or a join, recorded by the write in
 * `d.pieces`) are one change; a comment body only the fork's text carries goes with every shown block
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
  const overridden = overriddenBlocks(F);
  // Comment bodies the fork changed. One whose visibility differs between the sides changes how a
  // block reads with no write of the fork's in it, so its Live carriers are read too.
  const bodies = F.overrideKeys("comments").filter(
    (comment) => !sameValue(L.baseValue("comments", comment), F.override("comments", comment)),
  );
  const liveCarriers = new Map(bodies.map((comment) => [comment, [] as BlockId[]]));
  if (bodies.length > 0)
    for (const id of L.shown)
      for (const comment of sides.live.carried(id)) liveCarriers.get(comment)?.push(id);
  const relit = new Set(
    bodies
      .filter(
        (comment) =>
          (L.baseValue("comments", comment) != null) !== (F.value("comments", comment) != null),
      )
      .flatMap((comment) => liveCarriers.get(comment) ?? []),
  );

  const changed: BlockId[] = [];
  // Hidden on both sides but written by the draft: a block the draft put inside a block it then
  // removed. It is no change of its own, but goes with that ancestor's, so discarding the removal
  // does not bring it back as a new change.
  const under: BlockId[] = [];
  for (const id of new Set([...L.ids, ...F.ids])) {
    const inLive = L.shown.has(id);
    if (inLive !== F.shown.has(id)) changed.push(id);
    else if (!inLive) {
      if (overridden.has(id)) under.push(id);
    } else if (
      // A block the fork has neither text nor an override for reads as Live's.
      (draft.texts.has(id) || overridden.has(id) || relit.has(id)) &&
      blockDiffers(sides.live, sides.fork, id)
    )
      changed.push(id);
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

  // Changed blocks the `d.pieces` records connect are one change. A block that is no change only
  // connects: a half split off and joined into the next paragraph, or a paragraph whose text
  // left and came back. It is no member, so no press writes anything of it.
  const linked = linkedPieces(F.overrideKeys("pieces"));
  const first = new Map<BlockId, BlockId>();
  for (const id of groups.members()) {
    if (!linked.has(id)) continue;
    const root = linked.find(id);
    const earlier = first.get(root);
    if (earlier === undefined) first.set(root, id);
    else groups.join(earlier, id);
  }

  // The blocks the fork can read a mark on that Live's read of them does not show: any other
  // block the fork shows reads Live's text under Live's node.
  const forkReads = [
    ...new Set([...draft.texts.keys(), ...overridden, ...insertedOrRemoved]),
  ].filter((id) => F.shown.has(id));
  const ownBodies: string[] = [];
  const carried = new Map<string, BlockId[]>();
  for (const comment of bodies) {
    const inLive = liveCarriers.get(comment) ?? [];
    if (inLive.length > 0 && L.baseValue("comments", comment) != null) {
      ownBodies.push(comment);
      continue;
    }
    // Live has no body to show: every block holding the mark on either side reads differently
    // for the body alone, so the body goes with them.
    const carriers = [
      ...new Set([...forkReads.filter((id) => sides.fork.carried(id).has(comment)), ...inLive]),
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

/** The blocks the fork holds an override of `parent`, `order`, `node` or attributes for. */
function overriddenBlocks(view: StructureView): Set<BlockId> {
  const out = new Set<BlockId>();
  for (const name of BLOCK_MAPS)
    for (const key of view.overrideKeys(name)) for (const id of membersOf(name, key)) out.add(id);
  return out;
}

/** The changes `selection` names, expanded to their whole groups. */
export function selectChanges(changes: readonly BlockChange[], selection: ChangeSelection) {
  if (selection === "all") return [...changes];
  const named = new Set(selection);
  return changes.filter((change) =>
    [...change.blocks, ...change.comments].some((id) => named.has(id)),
  );
}

/**
 * Live's version of the text docs under the blocks the draft removes in `changes` (design §2,
 * `DraftItem.liveVersion`): what a press from a list that shows no text carries as the Live the
 * writer was shown. Empty when the draft removes nothing.
 */
export function pendingRemovalVersion(
  draft: RoomDocs,
  changes: readonly BlockChange[] = changedBlocks(draft),
): RoomVersion {
  const live = draft.live;
  if (!live) throw new Error("pendingRemovalVersion needs a draft copy");
  const forkView = new StructureView(draft);
  const liveView = new StructureView(live);
  const out = new Map<DocKey, DocVersion>();
  for (const change of changes)
    for (const id of change.blocks) {
      if (!removalOf(forkView.override("order", id))) continue;
      for (const key of liveView.textKeysUnder(id)) {
        const doc = live.textOf(key);
        if (doc) out.set(key, docVersion(doc));
      }
    }
  return out;
}

/**
 * One change a press acted on, as its Undo needs it (design §2, "For the press"): the change's
 * members (block ids, and comment ids for a comment body) and, per room, the edit the press made
 * there, noted as the press left it. A change's Live side and fork side are one edit: its Undo
 * takes both back or neither. JSON, as `press_changes` stores it.
 */
export interface PressedChange {
  /** Never empty: every change has a block or a comment body. */
  members: [string, ...string[]];
  live: StoredEdit | null;
  fork: StoredEdit | null;
}

/** What a press changed: the changes it acted on, and each room's changed docs, committed. */
export interface PressChanges {
  chosen: BlockChange[];
  /**
   * What its Undo takes back (`undoPress`), per change: the press's own writes, not the restores
   * a forward or an import wrote on the way, which are no one's step.
   */
  pressed: PressedChange[];
  /** Live's docs: commit them to the Live room first. */
  live: DocChange[];
  /** The fork's docs, including the restore a forward wrote. */
  fork: DocChange[];
}

export interface PressOptions {
  /** Who its commits are by: the press. */
  by?: CommitAuthor;
  /** All command peers belonging to one Work press, so its parts undo as one edit. */
  ownPeers?: ReadonlySet<PeerID>;
}

export interface ApplyOptions extends PressOptions {
  /**
   * The Live version of each text doc the writer was shown (design §2, `PressRequest.liveVersions`):
   * a block the draft removed is removed in Live with a record of it, capped at what this copy
   * holds, so Live typing the writer was not shown brings the block back. A text doc it names no
   * version for counts as never shown.
   */
  liveVersion: RoomVersion;
}

/** The overrides the fork holds for block `id`, by map: what Apply copies and Discard deletes. */
function overridesOf(view: StructureView, id: BlockId): [StructureMap, string][] {
  const out: [StructureMap, string][] = [];
  for (const name of BLOCK_MAPS)
    for (const key of view.overrideKeys(name))
      if (membersOf(name, key)[0] === id) out.push([name, key]);
  return out;
}

function forwarded(draft: RoomDocs, into: DocChange[]): void {
  const imported: Imported = draft.forward();
  into.push(...imported.answers);
}

/** What a press wrote in one room: each text doc's span, and its one structure commit. */
interface Wrote {
  docs: RoomDocs;
  texts: Map<DocKey, TextSpan>;
  structure: DocChange | null;
}

/** A text doc's change as an edit's span: every op between its frontiers is the press's. */
function spanOf({ doc, before, after }: DocChange): TextSpan {
  return { before, after, ops: opsBetween(doc, before, after) };
}

/**
 * Each chosen change's edit in each room, from what the press wrote there, split by the member
 * each key and text doc belongs to and noted now, as the press left the room. The author is the
 * room copy's peer: a command's copy has a fresh one, so every later write is someone else's.
 */
function pressedOf(
  chosen: readonly BlockChange[],
  rooms: (Wrote | null)[],
  retired: ReadonlyMap<string, BlockId>,
): PressedChange[] {
  const index = new Map<string, number>();
  chosen.forEach((change, i) => {
    for (const id of [...change.blocks, ...change.comments]) index.set(id, i);
  });
  const sides = rooms.map((wrote) => {
    if (!wrote) return null;
    const edits: Edit[] = chosen.map(() => ({
      peer: wrote.docs.peer,
      values: new Map(),
      texts: new Map(),
      leaving: new Map(),
      arriving: new Set(),
      shown: new Set(),
      structureAt: [],
    }));
    for (const [key, span] of wrote.texts) edits[index.get(key) as number].texts.set(key, span);
    if (wrote.structure) {
      const { doc, before, after } = wrote.structure;
      for (const [name, keys] of valuesOf(doc, before, after))
        for (const [key, value] of keys) {
          // A `pieces` record goes with the change that holds one of its blocks, or else with
          // the change its component connects to.
          const member = membersOf(name, key).find((id) => index.has(id)) ?? retired.get(key);
          const { values } = edits[index.get(member as string) as number];
          const into = values.get(name) ?? new Map();
          values.set(name, into.set(key, value));
        }
    }
    const view = new StructureView(wrote.docs);
    return edits.map((edit) => {
      if (edit.texts.size === 0 && edit.values.size === 0) return null;
      noteEdit(wrote.docs, edit, view);
      return storeEdit(wrote.docs, edit);
    });
  });
  return chosen.map((change, i) => ({
    members: [...change.blocks, ...change.comments] as PressedChange["members"],
    live: sides[0]?.[i] ?? null,
    fork: sides[1]?.[i] ?? null,
  }));
}

/**
 * Apply (design §2, "Apply is an import"): forward, then for each chosen change set in Live the
 * value of each override the fork holds and delete the override in the fork, have Live import the
 * fork's text ops for the blocks the fork wrote (`importBatch`; a block the draft created becomes
 * Live's own doc), and copy the comment bodies the change carries. A block the draft removed is
 * removed in Live by a new record (`ApplyOptions.liveVersion`), never the fork's. A selection whose
 * changes are already empty changes nothing. Both copies are committed by `by`; the fork
 * is forwarded again, so it reads as before. Run it on a command's own copy, so the press's
 * writes have a peer of their own (`PressedChange`).
 */
export function applyBlocks(
  draft: RoomDocs,
  selection: ChangeSelection,
  options: ApplyOptions,
): PressChanges {
  const live = draft.live;
  if (!live) throw new Error("applyBlocks needs a draft copy");
  const result: PressChanges = { chosen: [], pressed: [], live: [], fork: [] };
  forwarded(draft, result.fork);
  result.chosen = selectChanges(changedBlocks(draft), selection);
  const blocks = result.chosen.flatMap((change) => change.blocks);
  const comments = result.chosen.flatMap((change) => change.comments);
  if (blocks.length + comments.length === 0) return result;

  const forkView = new StructureView(draft);
  const liveView = new StructureView(live);
  const liveBefore = new Map<DocKey, Frontiers>();
  // Live's version of each doc the import below writes, before it: empty for a doc Live lacks.
  const held = new Map<DocKey, DocVersion>();
  const batch = new Map<DocKey, Uint8Array>();
  let importedAnswers: DocChange[] = [];
  for (const id of blocks) {
    const text = draft.texts.get(id);
    if (!text) continue;
    const base = live.texts.get(id);
    held.set(id, base ? docVersion(base) : new Map());
    if (base) liveBefore.set(id, base.frontiers());
    batch.set(
      id,
      base
        ? withVector(docVersion(base), (from) => text.export({ mode: "update", from }))
        : text.export({ mode: "update" }),
    );
  }
  if (batch.size > 0) {
    const imported = live.importBatch(batch);
    // The imported span must precede an answer on the same text doc. `encodeChanges` uses the
    // first change for a key as its frontier, and an answer alone would omit the dependency it
    // deletes against.
    importedAnswers = imported.answers;
    result.live.push(...importedAnswers.filter((change) => change.key === STRUCTURE_KEY));
  }
  const liveTexts = new Map<DocKey, TextSpan>();
  for (const key of batch.keys()) {
    const at = liveBefore.get(key) ?? [];
    const doc = live.texts.get(key);
    if (!doc || sameValue(at, doc.frontiers())) continue;
    const change = { key, doc, before: at, after: doc.frontiers() };
    result.live.push(change);
    liveTexts.set(key, spanOf(change));
  }
  result.live.push(...importedAnswers.filter((change) => change.key !== STRUCTURE_KEY));

  // What the removal read of one text doc: what the writer was shown of Live, capped at what Live held before
  // the press, plus the draft's own ops the press brings, which every peer receiving the press
  // holds and must count as read.
  const seenOf = (key: DocKey): DocVersion => {
    const base = live.textOf(key);
    const before = held.get(key) ?? (base ? docVersion(base) : new Map());
    const out = new Map<string, number>();
    for (const [peer, counter] of options.liveVersion.get(key) ?? []) {
      const capped = Math.min(counter, before.get(peer) ?? 0);
      if (capped > 0) out.set(peer, capped);
    }
    const text = draft.texts.get(key);
    if (text)
      for (const [peer, counter] of docVersion(text))
        if (counter > (before.get(peer) ?? 0)) out.set(peer, counter);
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
  const liveCommit = commitStructure(live, liveStructure, { by: options.by });
  if (liveCommit) result.live.push(liveCommit);

  const forkStructure = draft.structure.frontiers();
  for (const id of blocks)
    for (const [name, key] of overridesOf(forkView, id))
      inMap(draft.structure, overrideMap(name), (map) => map.delete(key));
  for (const comment of comments)
    inMap(draft.structure, overrideMap("comments"), (map) => map.delete(comment));
  const retired = piecesOf(draft, blocks);
  deletePieces(draft, retired.keys());
  const forkCommit = commitStructure(draft, forkStructure, { by: options.by });
  if (forkCommit) result.fork.push(forkCommit);
  forwarded(draft, result.fork);
  result.pressed = pressedOf(
    result.chosen,
    [
      { docs: live, texts: liveTexts, structure: liveCommit },
      { docs: draft, texts: new Map(), structure: forkCommit },
    ],
    retired,
  );
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
  options: PressOptions = {},
): PressChanges {
  const live = draft.live;
  if (!live) throw new Error("discardBlocks needs a draft copy");
  const result: PressChanges = { chosen: [], pressed: [], live: [], fork: [] };
  forwarded(draft, result.fork);
  result.chosen = selectChanges(changedBlocks(draft), selection);
  const blocks = result.chosen.flatMap((change) => change.blocks);
  const comments = result.chosen.flatMap((change) => change.comments);
  if (blocks.length + comments.length === 0) return result;

  const view = new StructureView(draft);
  const texts = new Map<DocKey, TextSpan>();
  for (const id of blocks) {
    const text = draft.texts.get(id);
    const base = live.texts.get(id);
    if (!text || !base) continue;
    const before = text.frontiers();
    const liveNow = base.frontiers();
    const held = docVersion(base);
    const common = new Map<PeerID, number>();
    for (const [peer, counter] of docVersion(text)) {
      const n = Math.min(counter, held.get(peer) ?? 0);
      if (n > 0) common.set(peer, n);
    }
    const had = frontiersOf(text, common);
    text.applyDiff(text.diff(before, base.frontiers(), false));
    const message = commitMessage({
      by: options.by,
      undo: { for: deletedBetween(text, liveNow, before), ops: opsBetween(text, had, before) },
    });
    text.commit({ message });
    if (sameValue(before, text.frontiers())) continue;
    const change = { key: id, doc: text, before, after: text.frontiers() };
    result.fork.push(change);
    texts.set(id, spanOf(change));
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
  const retired = piecesOf(draft, blocks);
  deletePieces(draft, retired.keys());
  const commit = commitStructure(draft, structure, { by: options.by });
  if (commit) result.fork.push(commit);
  result.pressed = pressedOf(
    result.chosen,
    [null, { docs: draft, texts, structure: commit }],
    retired,
  );
  return result;
}

/** What a press's Undo changed, and the changes it left as they are. */
export interface PressUndo {
  /** Live's docs: commit them to the Live room first. */
  live: DocChange[];
  fork: DocChange[];
  /** The changes someone wrote over since the press (`editStays`): the Undo wrote nothing of them. */
  stayed: PressedChange[];
}

/**
 * The Undo of a press (Apply or Discard) on a draft copy (design §2, "An Undo takes an edit back
 * whole, or leaves it whole"): forward, then test each change, its Live and fork sides as one
 * edit; a change someone wrote over stays, as a peer's edit would. Live takes back the rest
 * (`takeBack`); the fork, forwarded again, takes the text Live's Undo removed back as its own
 * edit, between its own frontiers either side of that forward, so what the draft typed since stays
 * and the change is pending again; then the fork takes back its own side (the overrides a press
 * deleted, a Discard's text). Commit Live's docs first. Run it on a command's own copy.
 */
export function undoPress(
  draft: RoomDocs,
  pressed: readonly PressedChange[],
  options: PressOptions = {},
): PressUndo {
  const live = draft.live;
  if (!live) throw new Error("undoPress needs a draft copy");
  const result: PressUndo = { live: [], fork: [], stayed: [] };
  forwarded(draft, result.fork);
  const liveView = new StructureView(live);
  const forkView = new StructureView(draft);
  const liveEdits: Edit[] = [];
  const forkEdits: Edit[] = [];
  for (const change of pressed) {
    const onLive = change.live && loadEdit(live, change.live);
    const onFork = change.fork && loadEdit(draft, change.fork);
    if (onLive) onLive.ownPeers = options.ownPeers;
    if (onFork) onFork.ownPeers = options.ownPeers;
    if (onLive) onLive.ownPress = true;
    if (onFork) onFork.ownPress = true;
    if (
      (onLive && editStays(live, onLive, liveView)) ||
      (onFork && editStays(draft, onFork, forkView))
    ) {
      result.stayed.push(change);
      continue;
    }
    if (onLive) liveEdits.push(onLive);
    if (onFork) forkEdits.push(onFork);
  }
  result.live = takeBack(live, liveEdits, liveView, options.by);
  // The text Live's Undo took out comes back in the fork as the fork's own edit: put-back text
  // that stands for what Live's Undo deleted.
  const pending = new Map<DocKey, Frontiers>();
  for (const change of result.live) {
    const own = change.key === STRUCTURE_KEY ? undefined : draft.texts.get(change.key);
    if (own) pending.set(change.key, own.frontiers());
  }
  forwarded(draft, result.fork);
  for (const [key, at] of pending) {
    const doc = draft.texts.get(key) as LoroDoc;
    const after = doc.frontiers();
    if (sameValue(at, after)) continue;
    const message = commitMessage({
      by: options.by,
      undo: { for: deletedBetween(doc, at, after), ops: opsBetween(doc, at, after) },
    });
    doc.applyDiff(doc.diff(after, at, false));
    doc.commit({ message });
    result.fork.push({ key, doc, before: after, after: doc.frontiers() });
  }
  result.fork.push(...takeBack(draft, forkEdits, new StructureView(draft), options.by));
  return result;
}

/** One write of a turn into a room: each doc it wrote, at its version as the write began and as it landed. */
export interface TurnWrite {
  before: RoomVersion;
  after: RoomVersion;
}

/**
 * Where `Restore before` takes a room back to, from the turn's writes into it in order: each doc
 * at its version as the turn's first write into it began, and the structure's version as the
 * turn's last write into the structure landed. A write names only the docs it wrote, so each is
 * taken per doc.
 */
export interface TurnSpan {
  before: RoomVersion;
  after: DocVersion | null;
}

export function turnSpan(writes: readonly TurnWrite[]): TurnSpan {
  const before = new Map<DocKey, DocVersion>();
  let after: DocVersion | null = null;
  for (const write of writes) {
    for (const [key, at] of write.before) if (!before.has(key)) before.set(key, at);
    after = write.after.get(STRUCTURE_KEY) ?? after;
  }
  return { before, after };
}

/**
 * The docs `restoreBefore` goes back in: the room's own text docs the turn wrote, and the
 * structure when the turn wrote it.
 */
function restoredDocs(docs: RoomDocs, span: TurnSpan): [DocKey, LoroDoc, DocVersion][] {
  const out: [DocKey, LoroDoc, DocVersion][] = [];
  for (const [key, start] of span.before) {
    if (start.size === 0) continue;
    if (key === STRUCTURE_KEY) {
      if (span.after) out.push([key, docs.structure, start]);
      continue;
    }
    const doc = docs.texts.get(key);
    if (doc) out.push([key, doc, start]);
  }
  return out;
}

/**
 * Whether `docs` still hold the history `restoreBefore` reads for `span`: no doc it goes back in
 * was cut below the turn's start (design §4's cutoff). A caller restores every room of a turn or
 * none (design §2).
 */
export function holdsSpan(docs: RoomDocs, span: TurnSpan): boolean {
  return restoredDocs(docs, span).every(
    ([, doc, start]) => !doc.isShallow() || docCovers(start, plainVersion(doc.shallowSinceVV())),
  );
}

/**
 * `Restore before` a Draft-mode turn (design §2): each doc the turn wrote goes back to where it
 * stood before the turn's first write into it (`span`, from `turnSpan`). In a draft's fork, a text
 * doc goes to that version merged with Live's version of it, so Live's edits forwarded since stay,
 * and the turn wrote only the structure's overrides. In a document only the draft holds, whose
 * text is in its own Live room, the docs go back as they are. The structure's values go back key
 * by key (`putBackValues`), keeping a key anyone wrote after the turn; a block the turn created
 * goes as a removal. The caller checks `holdsSpan` first. Returns the changes, committed.
 */
export function restoreBefore(
  docs: RoomDocs,
  span: TurnSpan,
  options: PressOptions = {},
): DocChange[] {
  const { live } = docs;
  const out: DocChange[] = [];
  if (live) forwarded(docs, out);
  for (const [key, doc, start] of restoredDocs(docs, span)) {
    if (key === STRUCTURE_KEY) continue;
    const target = new Map([[key, start]]);
    const base = live?.textOf(key);
    if (base) mergeVersion(target, new Map([[key, docVersion(base)]]));
    const head = doc.frontiers();
    doc.applyDiff(doc.diff(head, frontiersOf(doc, target.get(key) as DocVersion), false));
    doc.commit({ message: commitMessage({ by: options.by }) });
    if (!sameValue(head, doc.frontiers()))
      out.push({ key, doc, before: head, after: doc.frontiers() });
  }
  const start = span.before.get(STRUCTURE_KEY);
  if (start && span.after) {
    const { structure } = docs;
    const values = valuesOf(
      structure,
      frontiersOf(structure, start),
      frontiersOf(structure, span.after),
    );
    // In a fork the turn wrote only overrides: Live's keys in the range came with a forward.
    const maps = live ? OVERRIDE_MAPS : BASE_MAPS;
    for (const [name, keys] of values) {
      if (!maps.has(name)) values.delete(name);
      else
        inMap(structure, name, (map) => {
          for (const [key, { left }] of keys) if (!sameValue(map.get(key), left)) keys.delete(key);
        });
    }
    const { change } = putBackValues(docs, values, undefined, options.by);
    if (change) out.push(change);
  }
  return out;
}

const BASE_MAPS: ReadonlySet<string> = new Set(STRUCTURE_MAPS);
const OVERRIDE_MAPS: ReadonlySet<string> = new Set(STRUCTURE_MAPS.map(overrideMap));
