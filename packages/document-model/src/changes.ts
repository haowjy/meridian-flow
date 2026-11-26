import type { Frontiers, LoroDoc } from "loro-crdt";
import { type CommitAuthor, commitMessage } from "./commit-message.js";
import { Groups } from "./groups.js";
import { inMap } from "./handles.js";
import { loadEdit, type StoredEdit, storeEdit } from "./invert.js";
import { linkedPieces, piecesOf } from "./pieces.js";
import type { Imported, RoomDocs } from "./room-docs.js";
import {
  type BlockId,
  type DocKey,
  membersOf,
  overrideMap,
  STRUCTURE_KEY,
  type StructureMap,
  sameValue,
} from "./shape.js";
import { blockDiffers, Side } from "./side.js";
import { encodeRemoval, isOrderKey, removalOf, StructureView } from "./structure.js";
import { type Edit, readOf, type TextSpan, takeBack, valuesOf } from "./take-back.js";
import { type DocVersion, docVersion, type RoomVersion, withVector } from "./version.js";
import { commitStructure, type DocChange, StructureWriter } from "./write.js";

/**
 * One pending change of a draft (design §2, "The review unit is the block"): the blocks that go
 * together and the comment bodies that go with them. A press names a change by any of its members
 * and acts on all of them. A change with no blocks is a comment body some Live text carries.
 */
export interface BlockChange {
  blocks: BlockId[];
  comments: string[];
  /**
   * Blocks hidden in Live and in the fork that hang off this change (under a container it inserts
   * or removes, or tied to it by a `d.pieces` record), which the fork holds overrides for: no
   * member, so a press writes nothing of them into Live, but it deletes their overrides, so they
   * never come back as a change of their own.
   */
  hidden: BlockId[];
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
  // removed, or a half split off and joined away. It is never a member (a press would write its
  // removal over Live's own), but hangs off the change it is under or tied to, whose press
  // deletes its overrides, so discarding the removal does not bring it back as a new change.
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
  const hangsOff = new Map<BlockId, BlockId>();
  for (const id of [...changed, ...under])
    for (const view of [L, F]) {
      const at = changedAncestor(id, view);
      if (!at) continue;
      if (groups.has(id)) groups.join(at, id);
      else hangsOff.set(id, at);
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
  for (const id of under)
    if (!hangsOff.has(id) && linked.has(id)) {
      const member = first.get(linked.find(id));
      if (member !== undefined) hangsOff.set(id, member);
    }

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
      change = { blocks: [], comments: [], hidden: [] };
      out.set(root, change);
    }
    change.blocks.push(id);
  }
  for (const [comment, carriers] of carried)
    out.get(groups.find(carriers[0]))?.comments.push(comment);
  for (const [id, member] of hangsOff) out.get(groups.find(member))?.hidden.push(id);
  return [
    ...out.values(),
    ...ownBodies.map((comment) => ({ blocks: [], comments: [comment], hidden: [] })),
  ];
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

/** The overrides the fork holds for block `id`, by map: what Apply copies and a press deletes. */
function overridesOf(view: StructureView, id: BlockId): [StructureMap, string][] {
  const out: [StructureMap, string][] = [];
  for (const name of BLOCK_MAPS)
    for (const key of view.overrideKeys(name))
      if (membersOf(name, key)[0] === id) out.push([name, key]);
  return out;
}

/**
 * Delete the fork's overrides of the chosen changes' blocks, of the blocks hidden on both sides
 * that hang off them, of their comment bodies, and the `pieces` records of the components holding
 * their blocks (design §2, "A press deletes what it pressed"). Returns, by `pieces` key, the block
 * whose change each record goes with.
 */
function deletePressed(
  draft: RoomDocs,
  view: StructureView,
  chosen: readonly BlockChange[],
): Map<string, BlockId> {
  const pieces = piecesOf(
    draft,
    chosen.flatMap((change) => change.blocks),
  );
  const read: [StructureMap, string][] = [
    ...chosen.flatMap((change) => [
      ...[...change.blocks, ...change.hidden].flatMap((id) => overridesOf(view, id)),
      ...change.comments
        .filter((comment) => view.override("comments", comment) !== undefined)
        .map((comment): [StructureMap, string] => ["comments", comment]),
    ]),
    ...[...pieces.keys()].map((key): [StructureMap, string] => ["pieces", key]),
  ];
  for (const [name, key] of read)
    inMap(draft.structure, overrideMap(name), (map) => map.delete(key));
  return pieces;
}

function forwarded(draft: RoomDocs, into: DocChange[]): void {
  const imported: Imported = draft.forward();
  into.push(...imported.restore);
}

/** What a press wrote in one room: each text doc's span, and its one structure commit. */
interface Wrote {
  docs: RoomDocs;
  texts: Map<DocKey, TextSpan>;
  structure: DocChange | null;
}

/** A text doc's change as an edit's span. */
const spanOf = ({ before, after }: DocChange): TextSpan => ({ before, after });

/**
 * Each chosen change's edit in each room, from what the press wrote there, split by the member
 * each key and text doc belongs to.
 */
function pressedOf(
  chosen: readonly BlockChange[],
  rooms: (Wrote | null)[],
  retired: ReadonlyMap<string, BlockId>,
): PressedChange[] {
  const index = new Map<string, number>();
  chosen.forEach((change, i) => {
    for (const id of [...change.blocks, ...change.comments, ...change.hidden]) index.set(id, i);
  });
  const sides = rooms.map((wrote) => {
    if (!wrote) return null;
    const edits = chosen.map(
      (): Pick<Edit, "values" | "texts"> => ({ values: new Map(), texts: new Map() }),
    );
    for (const [key, span] of wrote.texts) edits[index.get(key) as number].texts.set(key, span);
    if (wrote.structure) {
      const { doc, before, after } = wrote.structure;
      for (const [name, keys] of valuesOf(doc, before, after))
        for (const [key, value] of keys) {
          const member = membersOf(name, key).find((id) => index.has(id)) ?? retired.get(key);
          const { values } = edits[index.get(member as string) as number];
          const into = values.get(name) ?? new Map();
          values.set(name, into.set(key, value));
        }
    }
    return edits.map((edit) =>
      edit.texts.size === 0 && edit.values.size === 0
        ? null
        : storeEdit(wrote.docs, { ...edit, read: readOf(wrote.docs, edit) }),
    );
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
    result.live.push(...imported.restore);
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
  const retired = deletePressed(draft, forkView, result.chosen);
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
 * delete the fork's overrides of its blocks (a block Live lacks then reads Live's value, none),
 * have each text doc the fork wrote take Live's content as its own edit, and delete the comment
 * bodies it carries. Live is not touched; nothing is unlinked.
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
    text.applyDiff(text.diff(before, base.frontiers(), false));
    text.commit({ message: commitMessage(options.by) });
    if (sameValue(before, text.frontiers())) continue;
    const change = { key: id, doc: text, before, after: text.frontiers() };
    result.fork.push(change);
    texts.set(id, spanOf(change));
  }
  const structure = draft.structure.frontiers();
  const retired = deletePressed(draft, view, result.chosen);
  const commit = commitStructure(draft, structure, { by: options.by });
  if (commit) result.fork.push(commit);
  result.pressed = pressedOf(
    result.chosen,
    [null, { docs: draft, texts, structure: commit }],
    retired,
  );
  return result;
}

/** What a press's Undo changed. */
export interface PressUndo {
  /** Live's docs: commit them to the Live room first. */
  live: DocChange[];
  fork: DocChange[];
}

/**
 * The Undo of a press (Apply or Discard) on a draft copy (design §2, "An Undo always runs"):
 * forward, then Live takes back its side of every change (`takeBack`); the fork, forwarded again,
 * takes the text Live's Undo removed back as its own edit, between its own frontiers either side
 * of that forward, so what the draft typed since stays and the change is pending again; then the
 * fork takes back its own side (the overrides a press deleted, a Discard's text). Commit Live's
 * docs first. Run it on a command's own copy.
 */
export function undoPress(
  draft: RoomDocs,
  pressed: readonly PressedChange[],
  options: PressOptions = {},
): PressUndo {
  const live = draft.live;
  if (!live) throw new Error("undoPress needs a draft copy");
  const result: PressUndo = { live: [], fork: [] };
  forwarded(draft, result.fork);
  const sides = (side: "live" | "fork", docs: RoomDocs) =>
    pressed.flatMap((change) => {
      const stored = change[side];
      return stored ? [loadEdit(docs, stored)] : [];
    });
  result.live = takeBack(live, sides("live", live), new StructureView(live), options.by);
  // The text Live's Undo took out comes back in the fork as the fork's own edit.
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
    doc.applyDiff(doc.diff(after, at, false));
    doc.commit({ message: commitMessage(options.by) });
    result.fork.push({ key, doc, before: after, after: doc.frontiers() });
  }
  result.fork.push(...takeBack(draft, sides("fork", draft), new StructureView(draft), options.by));
  return result;
}
