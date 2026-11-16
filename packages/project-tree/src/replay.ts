import { classifyFiletype, idHex } from "@meridian/contracts/protocol";
import { shownName } from "./names.js";
import {
  type Actor,
  type BlobRef,
  isSourceRoot,
  type NodeKind,
  type PurgeRecord,
  sourceIdOf,
  sourceRoot,
  type TreeRecord,
} from "./record.js";
import { descendantsOf } from "./shape.js";
import { readStored } from "./validate.js";

export type TreeNode = {
  id: string;
  kind: NodeKind;
  /** The name shown, which a sibling may share (rule 4). */
  name: string;
  /**
   * A later twin's suffix (rule 14): hex digits from the start of its id, without the `~`. Its
   * path segment is `name~suffix` (`entrySegment`); the first to arrive under a name has none.
   */
  suffix?: string;
  /** A folder's id, or a source root. */
  parent: string;
  /** The source this node is in now, from the top of its parent chain. */
  source: string;
  rank: string;
  /** A document's type: the last rename's that changed it, else its create's. */
  filetype?: string;
  /** The name was given, not chosen; false once a person has renamed the node. */
  provisional: boolean;
  aliases?: string[];
  hasProperties: boolean;
  /** In Trash: deleted, and nothing not deleted below it keeps it standing. */
  trashed: boolean;
  /** Deleted, but shown because something not deleted is inside (rule 3). */
  keptByChild: boolean;
  /**
   * Deleted in live, but shown in this Work's view because the Work has a pending change to it
   * (rule 7). Review marks it "Deleted"; Apply restores it and lands the change.
   */
  keptByPending: boolean;
  /** Trash emptied: gone for good, and in no Trash entry. */
  purged: boolean;
  blob?: BlobRef;
  createdBy: Actor;
  /** The actor of the record that last changed where it is or what it is called. */
  lastChangedBy: Actor;
  /** Order of arrival under its name, which decides which twin carries a suffix (rule 14). */
  arrival: number;
};

export type SkipReason =
  | "cycle"
  | "missing-node"
  | "missing-parent"
  | "parent-not-folder"
  | "duplicate"
  | "undo-other-node"
  | "purged"
  /** Rule 11: a document create or rename to a type that is not a tracked document. */
  | "type-not-editable"
  /** Rule 12: a rename to a type of another Yjs schema. */
  | "type-across-schemas"
  /** The value is not a record the server writes (decoded from a list that was changed outside the package). */
  | "unreadable";

/** One delete still in force: a Trash entry, with what it still takes. */
export type TrashEntry = {
  /** The delete record's id (a record that carries another names it in `from`). */
  id: string;
  from?: string;
  node: string;
  cascade: string[];
};

/** A move or rename, and what it says of one fact of its node. */
export type Holder<Says> = {
  id: string;
  says: Says;
  /** Its place in the replay, which orders the changes in force on a fact. */
  index: number;
};
export type LabelSays = { name: string; filetype?: string };
export type PlaceSays = { parent: string; rank: string };
/** A node's name and place as it was created, the changes in force on each in list order, and where it entered the list. */
export type NodeHistory = {
  born: LabelSays & PlaceSays;
  label: ReadonlyArray<Holder<LabelSays>>;
  place: ReadonlyArray<Holder<PlaceSays>>;
  createdAt: number;
};
/**
 * One record the replay took. `base` is the change at the bottom of its chain of `undoes`: the
 * change an Undo, an Undo of that Undo, and so on, are all about. The chain is every record
 * whose base has the same root, the copies of one change and the Undos about them.
 */
export type Change = {
  id: string;
  root: string;
  node: string;
  index: number;
  /** On an Undo: the root it names. */
  undoes?: string;
  /** In force as the list stands up to the end of the replay (`standingOf` over its chain). */
  inForce: boolean;
  base: Change;
  /** On a move or rename that is no Undo: what it says of each fact it sets, in force or not. */
  sets?: Sets;
  /** Sources changed at this record, before and after its settlement. */
  sources: readonly string[];
};

export type TreeProjection = {
  nodes: Map<string, TreeNode>;
  /** Per node, what it was created with and every change in force on its name and its place, in list order: the last of each holds it. */
  history: ReadonlyMap<string, NodeHistory>;
  /** Every record the replay took, by its id. */
  changes: ReadonlyMap<string, Change>;
  /** The ids of the records in force. */
  inForce: ReadonlySet<string>;

  /** Children of a folder or source root, in display order: by rank, then id. Trashed ones included. */
  children: Map<string, TreeNode[]>;
  /** Records the replay skipped, with why: what a review shows as "couldn't apply". */
  skipped: Array<{ record: string; reason: SkipReason }>;
  /** Creates whose folder was never created in this view: put at the top of their source (rule 6). */
  rescued: string[];
  /** Trash: the deletes in force that hide something (`hidingDeletes`). Per view, like the tree. */
  trash: TrashEntry[];
  /**
   * The root ids of the deletes in force (not lifted by a restore or an Undo, not purged): each
   * delete's own, and a delete that took a restore back while one of the deletes it put back is
   * in force. Undo may take these back, and only these.
   */
  standingDeletes: ReadonlySet<string>;
  /**
   * Those of `standingDeletes` that hide something now, by the same ids: what Trash lists. A
   * delete in force whose nodes all show (an Apply brought back what it took, or a create keeps
   * its folder standing) is out of this set until they leave again, and in `standingDeletes`
   * throughout.
   */
  hidingDeletes: ReadonlySet<string>;
  /** Documents in no view whose content was purged: a Discarded create, emptied from Trash. */
  gone: ReadonlySet<string>;
  /** Records the server dropped at admission (from the settle log; `replayView` fills it, `replay` has no log). */
  dropped: DroppedRecord[];
};

/** A record the server stamped `dropped` (it changed a closed Work), and the reason it gave. */
export type DroppedRecord = { record: Exclude<TreeRecord, PurgeRecord>; reason: string };

type Working = {
  id: string;
  kind: NodeKind;
  name: string;
  parent: string;
  rank: string;
  /** The source it was created in; the shown source is derived from the parent chain. */
  source: string;
  filetype?: string;
  provisional: boolean;
  aliases?: string[];
  hasProperties: boolean;
  blob?: BlobRef;
  createdBy: Actor;
  lastChangedBy: Actor;
  createdAt: number;
  /** Position of the record that last brought it to its parent under its name: who carries a suffix. */
  arrivedAt: number;
  /** Where it last came to stand in this list: its create, or the restore that brought it back. */
  stoodAt: number;
  /** Where it came under its parent: its create, or the move in force that last changed its parent. */
  placedAt: number;
  /** Where it came to show its name: its create, or the change in force that last changed it. */
  namedAt: number;
  born: LabelSays & PlaceSays;
  purged: boolean;
  /** The create it was made by, or the original a copy of that create carries. */
  root: string;
  label: Array<Holder<LabelSays>>;
  place: Array<Holder<PlaceSays>>;
};

/** The deletes a restore lifted, and the members it took out of the deletes of folders above it; `by` is the kind of record that lifted them. */
type Lifted = {
  by: TreeRecord["type"];
  entries: DeleteInForce[];
  members: Array<[DeleteInForce, string]>;
};

type DeleteInForce = {
  id: string;
  from?: string;
  /**
   * By the root id of each delete that took a restore back: the nodes of this entry it put in
   * force again (the entry's own, or members of its cascade), until a restore lifts them again.
   */
  putBackBy: Map<string, Set<string>>;
  node: string;
  cascade: Set<string>;
  /** The viewed Work's own delete, pending or already applied. */
  own: boolean;
};

/**
 * Turns records, in replay order, into a tree: the eight rules of the design, section 2. Each
 * value is read through `readStored` and the replay uses the copy that builds; one that is not a
 * record is skipped as `unreadable`.
 * `of.draft` is the Work whose view this is (null for live); `of.pendingText` the documents it
 * holds pending text of, which the list cannot see.
 */
export function replay(
  values: readonly unknown[],
  of: { draft?: string | null; pendingText?: ReadonlySet<string> } = {},
): TreeProjection {
  return startReplay(values, of).finish();
}

/** What `Replay.wouldTake` answers: why the replay would skip the record, or the sources it would change. */
export type WouldTake = { skipped: SkipReason } | { sources: readonly string[] };

/** A node as an Undo reads it from a replay that is still open. */
export type StandingNode = {
  id: string;
  kind: NodeKind;
  name: string;
  parent: string;
  rank: string;
  filetype?: string;
  purged: boolean;
  trashed: boolean;
};

/** The tree as a replay that is still open has it: what making an opposite record reads. */
export type TreeStanding = {
  node(id: string): StandingNode | undefined;
  history(id: string): NodeHistory | undefined;
  changes: ReadonlyMap<string, Change>;
  standingDeletes: ReadonlySet<string>;
  /** Every node below `id`, trashed ones included, in `descendantsOf`'s order. */
  descendants(id: string): string[];
};

/**
 * A replay that can take more records at its end. `replay(values)` is `startReplay(values).finish()`,
 * and `startReplay(values)` then `push(record)` is `startReplay([...values, record])`: one fold,
 * read a record at a time.
 */
export type Replay = {
  /** Replays one more record at the end of the list. Never a purge: rule 10 reads purges ahead of the list. */
  push(record: TreeRecord): void;
  /** What `push(record)` would do, changing nothing. */
  wouldTake(record: TreeRecord): WouldTake;
  /** The tree as the list stands, without the names shown: valid until the next `push`. */
  standing(): TreeStanding;
  /** The projection. The replay takes no record after it. */
  finish(): TreeProjection;
};

export function startReplay(
  values: readonly unknown[],
  of: { draft?: string | null; pendingText?: ReadonlySet<string> } = {},
): Replay {
  const nodes = new Map<string, Working>();
  const skipped: TreeProjection["skipped"] = [];
  const rescued: string[] = [];
  const gone = new Set<string>();
  const ownDelete = (record: TreeRecord) =>
    record.draft !== null || (of.draft != null && record.fromDraft === of.draft);
  // Rule 10: a purge is final wherever it sits. A Yjs-merged record placed before it in the list
  // (an offline restore or move admitted later) never lifts the delete it empties.
  const purgedDeletes = new Set<string>();
  // Each purged node, by the position of the purge that took it.
  const purgedAt = new Map<string, number>();
  const reads = values.map(readStored);
  for (const read of reads)
    if (read.ok && read.record.type === "purge") purgedDeletes.add(read.record.delete);
  const isFinal = (entry: DeleteInForce) =>
    purgedDeletes.has(entry.id) || (entry.from !== undefined && purgedDeletes.has(entry.from));
  let deletes: DeleteInForce[] = [];
  // What a restore lifted, and what a delete that took a restore back put in force again, by
  // the id an Undo of it names: taking either back undoes exactly that.
  const lifted = new Map<string, Lifted>();
  const pendingOn = new Map<string, Set<string>>();
  // A drafted change and the drafted record that takes it back leave nothing pending.
  const pend = (record: TreeRecord) => {
    if (record.draft === null) return;
    const on = pendingOn.get(record.node) ?? new Set<string>();
    if (record.undoes !== undefined && on.has(record.undoes)) on.delete(record.undoes);
    else on.add(record.carries ?? record.id);
    pendingOn.set(record.node, on);
  };

  // A node still in this list that something may be placed under or done to: purged nodes are in
  // no view, for placement as for display.
  const placeable = (id: string) => placeIn(nodes, id);

  // Lifts the deletes a restore (or, by rule 9, a move or rename of a node in Trash) takes back.
  // A touch by a drafted record lifts only the Work's own deletes: a live delete stays in force
  // in the Work's view (rule 7), and is lifted when the Apply lands the record live.
  const lift = (
    record: TreeRecord,
    node: Working,
    how: { index: number } | { ownOnly: boolean },
  ) => {
    const touch = "ownOnly" in how;
    const may = (entry: DeleteInForce) => !isFinal(entry) && (!touch || !how.ownOnly || entry.own);
    // Rule 8. A restore that takes one delete back lifts that delete alone, so one
    // author's Undo never reverses another's delete of the same node. A plain restore lifts
    // every delete of the node. Out of a deleted folder either brings back only the node
    // and what is inside it: they leave that folder's delete, and the folder stands holding
    // them (rule 3) with the rest in Trash. A restore that takes back the Undo of a restore
    // lifts again what that Undo put back.
    const again = record.undoes === undefined ? undefined : lifted.get(record.undoes);
    const took: Lifted = {
      by: record.type,
      entries: deletes.filter(
        (entry) => may(entry) && (again ? again.entries.includes(entry) : lifts(record, entry)),
      ),
      members: [],
    };
    deletes = deletes.filter((entry) => !took.entries.includes(entry));
    for (const entry of took.entries) entry.putBackBy.clear();
    // An Undo's restore puts the node back as it stood, arrival included: the twins read as before.
    if (!touch && record.undoes === undefined) {
      node.stoodAt = how.index;
      node.arrivedAt = how.index;
    }
    const takeOut = (entry: DeleteInForce, member: string) => {
      entry.cascade.delete(member);
      for (const nodes of entry.putBackBy.values()) nodes.delete(member);
      took.members.push([entry, member]);
    };
    if (again) for (const [entry, member] of again.members) takeOut(entry, member);
    else if (record.undoes === undefined)
      for (const entry of deletes) {
        if (!may(entry) || !wouldLoop(nodes, entry.node, record.node)) continue;
        for (const member of [...entry.cascade])
          if (member === record.node || wouldLoop(nodes, record.node, member))
            takeOut(entry, member);
      }
    // A create's Undo is a plain delete of the node: nothing to put back.
    if (record.type !== "create") lifted.set(record.carries ?? record.id, took);
  };

  // An Undo of a restore (or of a move or rename that lifted deletes, rule 9) takes it off: the
  // deletes it lifted are in force again, each with what it took and its own Trash entry.
  const putBack = (record: TreeRecord, back: Lifted) => {
    const root = record.carries ?? record.id;
    const put = (entry: DeleteInForce, node: string) =>
      entry.putBackBy.set(root, (entry.putBackBy.get(root) ?? new Set()).add(node));
    for (const entry of back.entries) {
      put(entry, entry.node);
      if (!deletes.includes(entry)) deletes.push(entry);
    }
    for (const [entry, member] of back.members) {
      entry.cascade.add(member);
      put(entry, member);
    }
    lifted.set(root, back);
  };

  // Every record the replay took, by its id, and by root (`carries ?? id`) the last of each family:
  // the one an Undo's `undoes` reaches. `chains`: by the root of their base, the records about
  // one change.
  const changes = new Map<string, Change>();
  const families = new Map<string, Change>();
  const chains = new Map<string, Change[]>();
  // The records about `record`'s change whose being in force taking `record` flips: the rule
  // (`standingOf`) over the chain as it stands, with `record` at its end.
  const flipsOf = (record: TreeRecord): Change[] => {
    const target = record.undoes === undefined ? undefined : families.get(record.undoes);
    const chain = target && chains.get(target.base.root);
    if (!chain) return [];
    const standing = standingOf([
      ...chain.map((each) => ({ id: each.id, carries: each.root, undoes: each.undoes })),
      record,
    ]);
    return chain.filter((each) => standing.has(each.id) !== each.inForce);
  };
  // The node's changes in force on each fact once `flips` have flipped.
  const turned = (node: Working, flips: readonly Change[]) => {
    let place: ReadonlyArray<Holder<PlaceSays>> = node.place;
    let label: ReadonlyArray<Holder<LabelSays>> = node.label;
    for (const each of flips)
      if (each.sets && each.node === node.id) {
        place = withTurned(place, each.sets.place, !each.inForce);
        label = withTurned(label, each.sets.label, !each.inForce);
      }
    return { place, label };
  };
  const take = (record: TreeRecord, index: number, sets?: Sets, flips = flipsOf(record)) => {
    const target = record.undoes === undefined ? undefined : families.get(record.undoes);
    const change: Change = {
      id: record.id,
      root: record.carries ?? record.id,
      node: record.node,
      index,
      inForce: true,
      sources: [],
      base: target?.base as Change,
    };
    if (record.undoes !== undefined) change.undoes = record.undoes;
    change.base = target?.base ?? change;
    if (sets) change.sets = sets;
    for (const id of new Set(flips.flatMap((each) => (each.sets ? [each.node] : [])))) {
      const node = nodes.get(id);
      if (!node) continue;
      const now = turned(node, flips);
      node.place = [...now.place];
      node.label = [...now.label];
      settle(node);
    }
    for (const each of flips) each.inForce = !each.inForce;
    changes.set(change.id, change);
    families.set(change.root, change);
    const chain = chains.get(change.base.root);
    if (chain) chain.push(change);
    else chains.set(change.base.root, [change]);
    return change;
  };
  const holder = <Says>(record: TreeRecord, index: number, says: Says): Holder<Says> => ({
    id: record.id,
    says,
    index,
  });
  // A move or rename sets what it says as it arrives: nothing after it in the list yet undoes it.
  // Rule 4: the node arrives where its parent or the name it shows changes, never before it
  // came to stand in the list.
  const set = (node: Working, sets: Sets, index: number) => {
    if (sets.place) {
      node.place.push(sets.place);
      if (sets.place.says.parent !== node.parent) node.placedAt = index;
      node.parent = sets.place.says.parent;
      node.rank = sets.place.says.rank;
    }
    if (sets.label) {
      node.label.push(sets.label);
      const filetype = sets.label.says.filetype ?? node.filetype;
      const name = shownName(node.kind, sets.label.says.name, filetype);
      if (name !== node.name) node.namedAt = index;
      node.name = name;
      if (filetype) node.filetype = filetype;
    }
    node.arrivedAt = Math.max(node.stoodAt, node.placedAt, node.namedAt);
  };
  // After an Undo turned a change on the node: it shows what the last change in force on each fact
  // says, and arrives where that run of changes began (an Undo gives back the arrival it had).
  const settle = (node: Working) => {
    const place = node.place.at(-1)?.says ?? node.born;
    node.parent = place.parent;
    node.rank = place.rank;
    const label = labelOf(node.kind, node.born, node.label);
    node.name = label.name;
    if (label.filetype) node.filetype = label.filetype;
    else delete node.filetype;
    node.placedAt = since(node, node.place, (says) => says.parent === node.parent);
    node.namedAt = since(
      node,
      node.label,
      (says) => shownName(node.kind, says.name, node.filetype) === node.name,
    );
    node.arrivedAt = Math.max(node.stoodAt, node.placedAt, node.namedAt);
  };
  // An Undo of a move or rename sets nothing itself: it flips which changes about its change are
  // in force, at its own place in the list, and the node shows what the changes in force then
  // say. One that would leave the node somewhere it cannot stand is skipped whole.
  const turnsTo = (
    record: TreeRecord,
    node: Working,
    flips: readonly Change[],
  ): { parent: string } | { skip: SkipReason } => {
    const to = turned(node, flips).place.at(-1)?.says ?? node.born;
    if (to.parent !== node.parent) {
      const why = cannotStand(record.node, to.parent);
      if (why) return { skip: why };
    }
    return { parent: to.parent };
  };
  // Where a node stands once `flips` have flipped.
  const parentAfter = (node: Working, flips: readonly Change[]) =>
    turned(node, flips).place.at(-1)?.says.parent ?? node.born.parent;
  // Why a node cannot be put under `parent`, if it cannot.
  const cannotStand = (node: string, parent: string): SkipReason | undefined => {
    if (!isSourceRoot(parent)) {
      const folder = placeable(parent);
      if (!folder) return "missing-parent";
      if (folder.kind !== "folder") return "parent-not-folder";
    }
    return wouldLoop(nodes, node, parent) ? "cycle" : undefined;
  };

  const sourceFrom = (parent: string | undefined): string | undefined => {
    let at = parent;
    for (let guard = 0; at !== undefined && guard <= nodes.size; guard += 1) {
      if (isSourceRoot(at)) return sourceIdOf(at);
      at = nodes.get(at)?.parent;
    }
    return undefined;
  };
  const sourceAt = (id: string) => sourceFrom(nodes.get(id)?.parent);
  const sourcesOf = (before: string | undefined, after: string | undefined) => [
    ...new Set([before, after].filter((s): s is string => s !== undefined)),
  ];
  /**
   * One record of the fold. Every check that skips a record must come before anything it changes:
   * with `dry` the step returns there, saying where the node would stand, and changes nothing. A
   * state change put before a skip check makes `wouldTake` change the replay, and every Undo's
   * answer goes wrong without a failure.
   */
  const step = (
    record: TreeRecord,
    index: number,
    dry: boolean,
  ): { skip: SkipReason } | { parent: string | undefined } | undefined => {
    const skip = (reason: SkipReason) => {
      if (!dry) skipped.push({ record: record.id, reason });
      return { skip: reason };
    };
    const target = record.undoes === undefined ? undefined : families.get(record.undoes);
    if (target && target.node !== record.node) return skip("undo-other-node");
    if (record.type === "create") {
      const existing = nodes.get(record.node);
      if (existing) {
        // The same create applied again after an Undo of its Apply (the first copy's node is in
        // Trash): it brings the node back, as a move would (rule 9). Any other is a repeat.
        if (existing.root !== (record.carries ?? record.id)) return skip("duplicate");
        if (dry) return { parent: parentAfter(existing, flipsOf(record)) };
        lift(record, existing, { ownOnly: record.draft !== null });
        pend(record);
        take(record, index);
        return;
      }
      if (record.kind === "document" && !isTracked(record.filetype))
        return skip("type-not-editable");
      // Rule 6: the folder it was made in was never created in this view (its create was
      // discarded concurrently), so the node shows at the top of its source.
      const rescue = !isSourceRoot(record.parent) && placeable(record.parent)?.kind !== "folder";
      const parentId = rescue ? sourceRoot(record.source) : record.parent;
      if (dry) return { parent: parentId };
      if (rescue) rescued.push(record.id);
      nodes.set(record.node, {
        id: record.node,
        kind: record.kind,
        name: shownName(record.kind, record.name, record.filetype),
        parent: parentId,
        rank: record.rank,
        source: record.source,
        ...(record.filetype ? { filetype: record.filetype } : {}),
        provisional: record.provisional === true,
        ...(record.aliases ? { aliases: record.aliases } : {}),
        hasProperties: record.hasProperties === true,
        ...(record.blob ? { blob: record.blob } : {}),
        createdBy: record.actor,
        lastChangedBy: record.actor,
        createdAt: index,
        arrivedAt: index,
        stoodAt: index,
        placedAt: index,
        namedAt: index,
        born: {
          name: record.name,
          ...(record.filetype ? { filetype: record.filetype } : {}),
          parent: parentId,
          rank: record.rank,
        },
        purged: false,
        root: record.carries ?? record.id,
        label: [],
        place: [],
      });
      take(record, index);
      return;
    }
    // A node is acted on only while it stands in this view (`placeIn`): the same test Undo and
    // restoring a Discard make before they append a record.
    const node = placeable(record.node);
    // A Discarded create is in no view: its purge is the one record that names a node not in
    // this one, and it says the document's content is gone.
    if (record.type === "purge" && !nodes.has(record.node)) {
      gone.add(record.node);
      return;
    }
    if (!node) return skip(nodes.has(record.node) ? "purged" : "missing-node");
    switch (record.type) {
      case "move": {
        if (record.undoes !== undefined) {
          const flips = flipsOf(record);
          const to = turnsTo(record, node, flips);
          if ("skip" in to) return skip(to.skip);
          if (dry) return to;
          take(record, index, undefined, flips);
          const back = lifted.get(record.undoes);
          if (back) putBack(record, back);
          pend(record);
          node.lastChangedBy = record.actor;
          return;
        }
        const why = cannotStand(record.node, record.parent);
        if (why) return skip(why);
        if (dry) return { parent: record.parent };
        // Rule 9: acting on a node in Trash brings it back (an Undo's opposite record never does).
        lift(record, node, { ownOnly: record.draft !== null });
        pend(record);
        const sets: Sets = {
          place: holder(record, index, { parent: record.parent, rank: record.rank }),
        };
        take(record, index, sets);
        set(node, sets, index);
        node.lastChangedBy = record.actor;
        return;
      }
      case "rename": {
        if (record.undoes !== undefined) {
          const flips = flipsOf(record);
          const to = turnsTo(record, node, flips);
          if ("skip" in to) return skip(to.skip);
          if (dry) return to;
          take(record, index, undefined, flips);
          // A rename that takes back only the name a move set leaves the deletes that move lifted lifted.
          const back = lifted.get(record.undoes);
          if (back?.by === "rename") putBack(record, back);
        } else {
          if (record.filetype !== undefined) {
            if (!isTracked(record.filetype)) return skip("type-not-editable");
            if (!node.filetype || schemaOf(node.filetype) !== schemaOf(record.filetype))
              return skip("type-across-schemas");
          }
          if (dry) return { parent: node.parent };
          lift(record, node, { ownOnly: record.draft !== null });
          const sets: Sets = {
            label: holder(record, index, {
              name: record.name,
              ...(record.filetype ? { filetype: record.filetype } : {}),
            }),
          };
          take(record, index, sets);
          set(node, sets, index);
        }
        pend(record);
        // A rename to the same name counts: it is how a writer keeps "Untitled" on purpose.
        if (record.actor.startsWith("user:")) node.provisional = false;
        node.lastChangedBy = record.actor;
        return;
      }
      case "delete": {
        if (dry) return { parent: parentAfter(node, flipsOf(record)) };
        const back = record.undoes === undefined ? undefined : lifted.get(record.undoes);
        take(record, index);
        if (back) {
          putBack(record, back);
          return;
        }
        // Two deletes of one node both count: each takes what its author saw.
        deletes.push({
          id: record.id,
          ...(record.carries ? { from: record.carries } : {}),
          putBackBy: new Map(),
          node: record.node,
          cascade: new Set(record.cascade),
          own: ownDelete(record),
        });
        return;
      }
      case "restore":
        if (dry) return { parent: parentAfter(node, flipsOf(record)) };
        // An Apply's restore of a node the Work's view kept brings back what live deleted and
        // leaves the node where it arrived: the twin the writer saw as plain stays plain.
        lift(record, node, record.fromDraft === undefined ? { index } : { ownOnly: false });
        take(record, index);
        return;
      case "purge": {
        // Rule 10: final, and exactly what the server found the delete covering when it purged
        // (and whose content it released). A node someone put inside since, by a record placed
        // before the purge but admitted after it, was not purged: it goes to its source's top.
        const entry = deletes.find((d) => d.id === record.delete || d.from === record.delete);
        if (!entry || entry.node !== record.node) return skip("missing-node");
        for (const id of record.nodes) {
          const gone = nodes.get(id);
          if (gone && !gone.purged) {
            gone.purged = true;
            purgedAt.set(id, index);
          }
        }
        deletes = deletes.filter((d) => d !== entry);
        take(record, index);
        return;
      }
    }
  };
  let count = 0;
  const read = (value: unknown, stored = readStored(value)) => {
    const index = count;
    count += 1;
    if (!stored.ok) {
      const id = (value as { id?: unknown } | null)?.id;
      skipped.push({ record: typeof id === "string" ? id : "", reason: "unreadable" });
      return;
    }
    const record = stored.record;
    const fresh = !changes.has(record.id);
    const before = sourceAt(record.node);
    step(record, index, false);
    const change = fresh ? changes.get(record.id) : undefined;
    if (change) change.sources = sourcesOf(before, sourceAt(record.node));
  };
  for (const [index, value] of values.entries()) read(value, reads[index]);

  let done = false;
  let cached: { count: number; tree: TreeStanding } | undefined;
  return {
    push(record) {
      if (done) throw new Error("replay: push after finish");
      if (record.type === "purge") throw new Error("replay: a purge cannot be pushed");
      read(record);
    },
    wouldTake(record) {
      if (record.type === "purge") throw new Error("replay: a purge cannot be pushed");
      const would = step(record, count, true);
      if (!would) return { sources: [] };
      if ("skip" in would) return { skipped: would.skip };
      return { sources: sourcesOf(sourceAt(record.node), sourceFrom(would.parent)) };
    },
    standing() {
      if (cached?.count === count) return cached.tree;
      const rescuedTo = rescueFromPurged(nodes, purgedAt);
      const { children, standing } = stand(
        nodes,
        deletes,
        pendingOn,
        of.pendingText ?? new Set(),
        rescuedTo,
      );
      const sorted = new Map<string, Working[]>();
      const kidsOf = (parent: string) => {
        let kids = sorted.get(parent);
        if (!kids) {
          kids = [...(children.get(parent) ?? [])].sort(byRankThenId);
          sorted.set(parent, kids);
        }
        return kids;
      };
      const tree: TreeStanding = {
        node(id) {
          const node = nodes.get(id);
          const state = node && standing.get(id);
          if (!node || !state) return undefined;
          return {
            id,
            kind: node.kind,
            name: node.name,
            parent: rescuedTo.get(id)?.parent ?? node.parent,
            rank: node.rank,
            ...(node.filetype ? { filetype: node.filetype } : {}),
            purged: node.purged,
            trashed: node.purged || (state.deleted && !state.keptByChild),
          };
        },
        history(id) {
          const node = nodes.get(id);
          return (
            node && {
              born: node.born,
              label: node.label,
              place: node.place,
              createdAt: node.createdAt,
            }
          );
        },
        changes,
        standingDeletes: rootsOf(inForce(nodes, deletes), (put) => put.size > 0),
        descendants: (id) => descendantsOf({ children: { get: kidsOf } }, id),
      };
      cached = { count, tree };
      return tree;
    },
    finish() {
      done = true;
      return {
        ...derive(
          nodes,
          deletes,
          pendingOn,
          of.pendingText ?? new Set(),
          skipped,
          rescued,
          gone,
          rescueFromPurged(nodes, purgedAt),
        ),
        changes,
        inForce: new Set([...changes.values()].flatMap((each) => (each.inForce ? [each.id] : []))),
        dropped: [],
      };
    },
  };
}

/** Where a node under a purged one shows, and when it arrived there. */
type Rescued = ReadonlyMap<string, { parent: string; arrivedAt: number }>;

/**
 * Every node standing directly under a purged one shows at the top of the source its place was in,
 * arriving there at that purge. Once purged a node takes nothing (`placeIn`), so what is under one
 * at the end was under it at its purge. The nodes are not changed: the fold reads them again, so
 * `derive` and `standing` must read a rescued node's parent and arrival through this overlay and
 * never from the node.
 */
function rescueFromPurged(
  nodes: Map<string, Working>,
  purgedAt: ReadonlyMap<string, number>,
): Rescued {
  const out = new Map<string, { parent: string; arrivedAt: number }>();
  if (purgedAt.size === 0) return out;
  const sourceAbove = (id: string) => {
    let parent = id;
    for (let guard = 0; !isSourceRoot(parent) && guard <= nodes.size; guard += 1)
      parent = nodes.get(parent)?.parent ?? parent;
    return parent;
  };
  for (const node of nodes.values()) {
    const at = node.purged ? undefined : purgedAt.get(node.parent);
    if (at === undefined) continue;
    out.set(node.id, { parent: sourceAbove(node.parent), arrivedAt: at });
  }
  return out;
}

/** Whether a restore lifts a delete: the one it `undoes`, or every delete of the node if it undoes none. */
export const lifts = (
  restore: { node: string; undoes?: string },
  entry: { id: string; node: string; from?: string },
) =>
  entry.node === restore.node &&
  (restore.undoes === undefined || entry.id === restore.undoes || entry.from === restore.undoes);

/**
 * A node something may be placed under or done to: its create is in force in the view (the node
 * is in the list), and it was not purged. What Undo and restoring a Discard check before they
 * append a record for a node, and what the replay checks as it reads one.
 */
export function placeIn<Node extends { purged: boolean }>(
  nodes: ReadonlyMap<string, Node>,
  id: string,
): Node | undefined {
  const node = nodes.get(id);
  return node && !node.purged ? node : undefined;
}

export type Sets = { label?: Holder<LabelSays>; place?: Holder<PlaceSays> };

/**
 * A node's changes in force on one fact with `mine` put out of force, or back in at its own place
 * in the list. The replay and `undoChange` both read what an Undo does from this.
 */
export function withTurned<Says>(
  stack: ReadonlyArray<Holder<Says>>,
  mine: Holder<Says> | undefined,
  on: boolean,
): ReadonlyArray<Holder<Says>> {
  if (!mine) return stack;
  const rest = stack.filter((each) => each !== mine);
  if (!on) return rest;
  const after = rest.findIndex((each) => each.index > mine.index);
  return after < 0 ? [...rest, mine] : [...rest.slice(0, after), mine, ...rest.slice(after)];
}

/** The name and type a node shows: what the last change in force says, the type from the last that set one. */
export function labelOf(
  kind: NodeKind,
  born: LabelSays,
  label: ReadonlyArray<Holder<LabelSays>>,
): LabelSays {
  const filetype = label.findLast((each) => each.says.filetype)?.says.filetype ?? born.filetype;
  const name = label[label.length - 1]?.says.name ?? born.name;
  return { name: shownName(kind, name, filetype), ...(filetype ? { filetype } : {}) };
}

/**
 * When a node came to show what `same` accepts of one fact: the earliest of the changes in force
 * that, one after another up to the last, say so; its create when it was created so too.
 */
function since<Says>(
  node: Working,
  stack: ReadonlyArray<Holder<Says>>,
  same: (says: Says) => boolean,
): number {
  let at: number | undefined;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const each = stack[i] as Holder<Says>;
    if (!same(each.says)) return at ?? each.index;
    at = each.index;
  }
  return at !== undefined && !same(node.born as unknown as Says) ? at : node.createdAt;
}

/** Whether putting `node` under `parent` would put a folder inside itself (rule 1). */
export function wouldLoop(
  nodes: ReadonlyMap<string, { parent: string }>,
  node: string,
  parent: string,
): boolean {
  let at: string | undefined = parent;
  for (let guard = 0; at !== undefined && guard <= nodes.size; guard += 1) {
    if (at === node) return true;
    at = nodes.get(at)?.parent;
  }
  return false;
}

/**
 * The ids of the records in force: a record is, unless a later record in force undoes its root
 * (`carries ?? id`). So a change with any Undo in force is out, and an Undo of an Undo brings it
 * back only while no other Undo of it is in force. One pass from the end of the records given:
 * the replay runs it over one change's chain each time an Undo arrives.
 */
export function standingOf(
  records: ReadonlyArray<Pick<TreeRecord, "id" | "carries" | "undoes">>,
): Set<string> {
  const undone = new Set<string>();
  const standing = new Set<string>();
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i] as Pick<TreeRecord, "id" | "carries" | "undoes">;
    if (undone.has(record.carries ?? record.id)) continue;
    standing.add(record.id);
    if (record.undoes !== undefined) undone.add(record.undoes);
  }
  return standing;
}

type Standing = { deleted: boolean; keptByChild: boolean; keptByPending: boolean; source: string };

/**
 * One pass over the nodes, parents before children on the way down and children before parents
 * on the way up: what is deleted (rules 2 and 7) and which deleted folders stand (rule 3). Cost
 * follows the number of nodes and what the deletes name, not depth. An open replay's `standing` and
 * `derive` both read the tree from this.
 */
function stand(
  nodes: Map<string, Working>,
  deletes: DeleteInForce[],
  pendingOn: Map<string, Set<string>>,
  pendingText: ReadonlySet<string>,
  rescuedTo: Rescued,
): { children: Map<string, Working[]>; standing: Map<string, Standing> } {
  const children = new Map<string, Working[]>();
  for (const node of nodes.values()) {
    const parent = rescuedTo.get(node.id)?.parent ?? node.parent;
    const siblings = children.get(parent);
    if (siblings) siblings.push(node);
    else children.set(parent, [node]);
  }
  // A delete applies to a node when the node is the delete's own, or a member of its cascade
  // with the delete's node above it.
  const ownedBy = new Map<string, DeleteInForce[]>();
  const takenBy = new Map<string, DeleteInForce[]>();
  for (const entry of deletes) {
    ownedBy.set(entry.node, [...(ownedBy.get(entry.node) ?? []), entry]);
    for (const member of entry.cascade)
      if (nodes.has(member)) takenBy.set(member, [...(takenBy.get(member) ?? []), entry]);
  }
  const pendingNodes = new Set([
    ...[...pendingOn].flatMap(([node, on]) => (on.size > 0 ? [node] : [])),
    ...pendingText,
  ]);

  const standing = new Map<string, Standing>();
  const active = new Set<DeleteInForce>();
  type Frame = {
    key: string;
    kids: Working[];
    next: number;
    liveBelow: boolean;
    source: string;
    node?: Working;
  };
  const stack: Frame[] = [];
  const open = (key: string, source: string, node?: Working) =>
    stack.push({ key, kids: children.get(key) ?? [], next: 0, liveBelow: false, source, node });

  for (const root of children.keys()) {
    if (!isSourceRoot(root)) continue;
    open(root, sourceIdOf(root));
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      const child = frame.kids[frame.next];
      if (child) {
        frame.next += 1;
        const mine = ownedBy.get(child.id);
        const cascades = takenBy.get(child.id);
        let deleted = false;
        let draftDeleted = false;
        if (mine)
          for (const entry of mine) {
            active.add(entry);
            deleted = true;
            draftDeleted ||= entry.own;
          }
        if (cascades)
          for (const entry of cascades)
            if (active.has(entry)) {
              deleted = true;
              draftDeleted ||= entry.own;
            }
        // Rule 7: a delete in live does not take a node this Work has a pending change to,
        // unless the Work deleted it too: it stays in the Work's view, marked.
        const keptByPending = deleted && !draftDeleted && pendingNodes.has(child.id);
        standing.set(child.id, {
          deleted: deleted && !keptByPending,
          keptByChild: false,
          keptByPending,
          source: frame.source,
        });
        open(child.id, frame.source, child);
        continue;
      }
      stack.pop();
      const node = frame.node;
      if (!node) continue;
      for (const entry of ownedBy.get(node.id) ?? []) active.delete(entry);
      const state = standing.get(node.id) as Standing;
      // Rule 3: a node nobody deleted keeps every folder above it standing.
      state.keptByChild = state.deleted && frame.liveBelow;
      const parent = stack[stack.length - 1];
      if (parent && (!state.deleted || frame.liveBelow)) parent.liveBelow = true;
    }
  }
  return { children, standing };
}

const inForce = (nodes: Map<string, Working>, deletes: DeleteInForce[]) =>
  deletes.filter((entry) => nodes.has(entry.node) && !nodes.get(entry.node)?.purged);

/**
 * The deletes in force that still hide something: their node or a member of their cascade. An
 * entry whose nodes all show has nothing in Trash and nothing for an Undo to bring back now, and
 * hides them again once what keeps them standing leaves.
 */
const deletesInTrash = (
  nodes: Map<string, Working>,
  deletes: DeleteInForce[],
  standing: ReadonlyMap<string, Standing>,
) =>
  inForce(nodes, deletes).filter((entry) =>
    [entry.node, ...entry.cascade].some((id) => hidden(standing, id)),
  );

const hidden = (standing: ReadonlyMap<string, Standing>, id: string) => {
  const state = standing.get(id);
  return state?.deleted === true && !state.keptByChild;
};

/**
 * The root ids an Undo reaches `entries` by (`standingDeletes`, `hidingDeletes`): each entry's
 * own, and each restore's Undo that put it back while what it put back `counts`.
 */
const rootsOf = (entries: DeleteInForce[], counts: (put: ReadonlySet<string>) => boolean) =>
  new Set(
    entries.flatMap((entry) => [
      entry.id,
      entry.from ?? entry.id,
      ...[...entry.putBackBy].flatMap(([root, put]) => (counts(put) ? [root] : [])),
    ]),
  );

/** The projection: `stand`, then the names shown (rule 4) and each node as the view shows it. */
function derive(
  nodes: Map<string, Working>,
  deletes: DeleteInForce[],
  pendingOn: Map<string, Set<string>>,
  pendingText: ReadonlySet<string>,
  skipped: TreeProjection["skipped"],
  rescued: string[],
  gone: ReadonlySet<string>,
  rescuedTo: Rescued,
): Omit<TreeProjection, "dropped" | "changes" | "inForce"> {
  const { children, standing } = stand(nodes, deletes, pendingOn, pendingText, rescuedTo);
  const parentOf = (node: Working) => rescuedTo.get(node.id)?.parent ?? node.parent;
  const arrivedAt = (node: Working) => rescuedTo.get(node.id)?.arrivedAt ?? node.arrivedAt;
  const suffixes = new Map<string, string>();
  for (const kids of children.values()) {
    const shown = kids
      .filter((kid) => {
        const state = standing.get(kid.id);
        return !kid.purged && state && (!state.deleted || state.keptByChild);
      })
      // Rule 14: the node already standing keeps the plain name; the one that arrived later carries a suffix.
      .sort((a, b) => arrivedAt(a) - arrivedAt(b) || a.createdAt - b.createdAt);
    for (const [id, suffix] of suffixesInArrival(shown)) suffixes.set(id, suffix);
  }

  const out = new Map<string, TreeNode>();
  const history = new Map<string, NodeHistory>();
  for (const node of nodes.values()) {
    history.set(node.id, {
      born: node.born,
      label: node.label,
      place: node.place,
      createdAt: node.createdAt,
    });
    const state = standing.get(node.id) as Standing;
    out.set(node.id, {
      id: node.id,
      kind: node.kind,
      name: node.name,
      ...(suffixes.has(node.id) ? { suffix: suffixes.get(node.id) } : {}),
      parent: parentOf(node),
      source: state.source,
      rank: node.rank,
      ...(node.filetype ? { filetype: node.filetype } : {}),
      provisional: node.provisional,
      ...(node.aliases ? { aliases: node.aliases } : {}),
      hasProperties: node.hasProperties,
      trashed: node.purged || (state.deleted && !state.keptByChild),
      keptByChild: state.keptByChild,
      keptByPending: state.keptByPending,
      purged: node.purged,
      ...(node.blob ? { blob: node.blob } : {}),
      createdBy: node.createdBy,
      lastChangedBy: node.lastChangedBy,
      arrival: arrivedAt(node),
    });
  }
  const ordered = new Map<string, TreeNode[]>();
  for (const [parent, kids] of children)
    ordered.set(parent, kids.map((kid) => out.get(kid.id) as TreeNode).sort(byRankThenId));
  const inTrash = deletesInTrash(nodes, deletes, standing);
  // A delete covers the nodes of its cascade whose ancestry still runs through its node: one
  // moved out since (by a move placed before the delete, whose author did not see it) is not.
  const covered = (entry: DeleteInForce) =>
    [...entry.cascade].filter((member) => {
      for (let at = nodes.get(member); at; at = nodes.get(parentOf(at)))
        if (at.id === entry.node) return true;
      return false;
    });
  return {
    nodes: out,
    history,
    children: ordered,
    skipped,
    rescued,
    gone,
    trash: inTrash.map((entry) => ({
      id: entry.id,
      ...(entry.from ? { from: entry.from } : {}),
      node: entry.node,
      cascade: covered(entry),
    })),
    standingDeletes: rootsOf(inForce(nodes, deletes), (put) => put.size > 0),
    hidingDeletes: rootsOf(inTrash, (put) => [...put].some((id) => hidden(standing, id))),
  };
}

/**
 * Rule 14 over one folder's shown children listed in arrival order: the suffix of each that
 * carries one. The replay's own reading, for a planner that knows the ids and the order its
 * creates will arrive in (an import spelling its links before the tree has them).
 */
export function suffixesInArrival(
  children: readonly { id: string; name: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  const plain = new Set<string>();
  const twins: string[] = [];
  for (const kid of children) {
    if (plain.has(kid.name)) twins.push(kid.id);
    else plain.add(kid.name);
  }
  if (twins.length === 0) return out;
  // Sorted, so the longest start an id shares with any other is the one it shares with a neighbour.
  const hexes = children.map((kid) => idHex(kid.id)).sort();
  const index = new Map(hexes.map((hex, at) => [hex, at]));
  for (const twin of twins) {
    const hex = idHex(twin);
    const at = index.get(hex) as number;
    const shared = Math.max(common(hex, hexes[at - 1]), common(hex, hexes[at + 1]));
    out.set(twin, hex.slice(0, Math.max(4, shared + 1)));
  }
  return out;
}

function common(a: string, b: string | undefined): number {
  if (b === undefined) return 0;
  let n = 0;
  while (n < a.length && a[n] === b[n]) n += 1;
  return n;
}

/** By rank, then id, so equal ranks from concurrent inserts still sort the same everywhere. */
function byRankThenId(a: { rank: string; id: string }, b: { rank: string; id: string }): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const isTracked = (type: string | undefined): boolean =>
  type !== undefined && classifyFiletype(type).kind === "tracked";

function schemaOf(type: string): string | null {
  const classification = classifyFiletype(type);
  return classification.kind === "tracked" ? classification.schemaType : null;
}

/**
 * The delete in force that covers a node: its own, else the nearest one above it whose cascade
 * names it. The one reading of "who deleted this" for rows, Trash and the tools; the latest of
 * two deletes of one node answers.
 */
export function deleteCovering(projection: TreeProjection, id: string): TrashEntry | undefined {
  return deletesCovering(projection, id)[0];
}

/**
 * Every delete in force that covers a node, nearest first: its own, then each one above it whose
 * cascade names it, each node's latest first. A nearer delete doesn't hide a farther one,
 * so a command can ask whether any delete it made covers the node.
 */
export function deletesCovering(projection: TreeProjection, id: string): TrashEntry[] {
  const out: TrashEntry[] = [];
  for (let at = projection.nodes.get(id); at; at = projection.nodes.get(at.parent)) {
    const node = at.id;
    out.push(
      ...projection.trash
        .filter((each) => each.node === node && (node === id || each.cascade.includes(id)))
        .reverse(),
    );
  }
  return out;
}

/**
 * The records that are one node's item in a view: those made on it, and the delete in force that
 * covers it from a folder above (`deleteCovering`). A delete whose recorded cascade names the node
 * is not among them once the node has left the folder: the cascade is what its author saw.
 * Applying an item adds what these records stand on, and nothing else (`prerequisites`).
 */
export function recordsOfItem(
  projection: TreeProjection,
  records: readonly TreeRecord[],
  node: string,
): TreeRecord[] {
  const covering = deleteCovering(projection, node);
  return records.filter(
    (record) => record.node === node || (record.type === "delete" && record.id === covering?.id),
  );
}
