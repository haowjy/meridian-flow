import { classifyFiletype, idHex } from "@meridian/contracts/protocol";
import { shownName } from "./names.js";
import {
  type Actor,
  type BlobRef,
  isSourceRoot,
  type NodeKind,
  type PurgeRecord,
  readActor,
  sourceIdOf,
  sourceRoot,
  type TreeRecord,
} from "./record.js";
import { descendantsOf } from "./shape.js";
import { compareRankThenId } from "./siblings.js";
import { readStored } from "./validate.js";

export type TreeNode = {
  id: string;
  kind: NodeKind;
  name: string;
  suffix?: string;
  parent: string;
  source: string;
  rank: string;
  filetype?: string;
  provisional: boolean;
  aliases?: string[];
  hasProperties: boolean;
  trashed: boolean;
  keptByChild: boolean;
  purged: boolean;
  blob?: BlobRef;
  createdBy: Actor;
  lastChangedBy: Actor;
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
  | "type-not-editable"
  | "type-across-schemas"
  | "unreadable";

export type TrashEntry = {
  id: string;
  from?: string;
  node: string;
  cascade: string[];
};

export type Holder<Says> = {
  id: string;
  says: Says;
  index: number;
};
export type LabelSays = { name: string; filetype?: string };
export type PlaceSays = { parent: string; rank: string };
export type NodeHistory = {
  born: LabelSays & PlaceSays;
  label: ReadonlyArray<Holder<LabelSays>>;
  place: ReadonlyArray<Holder<PlaceSays>>;
  createdAt: number;
};
export type Change = {
  id: string;
  root: string;
  node: string;
  index: number;
  undoes?: string;
  inForce: boolean;
  base: Change;
  sets?: Sets;
  sources: readonly string[];
};

export type TreeProjection = {
  nodes: Map<string, TreeNode>;
  history: ReadonlyMap<string, NodeHistory>;
  changes: ReadonlyMap<string, Change>;
  inForce: ReadonlySet<string>;

  children: Map<string, TreeNode[]>;
  skipped: Array<{ record: string; reason: SkipReason }>;
  rescued: string[];
  trash: TrashEntry[];
  standingDeletes: ReadonlySet<string>;
  hidingDeletes: ReadonlySet<string>;
  gone: ReadonlySet<string>;
  dropped: DroppedRecord[];
};

export type DroppedRecord = { record: Exclude<TreeRecord, PurgeRecord>; reason: string };

type Working = {
  id: string;
  kind: NodeKind;
  name: string;
  parent: string;
  rank: string;
  source: string;
  filetype?: string;
  provisional: boolean;
  aliases?: string[];
  hasProperties: boolean;
  blob?: BlobRef;
  createdBy: Actor;
  lastChangedBy: Actor;
  createdAt: number;
  arrivedAt: number;
  stoodAt: number;
  placedAt: number;
  namedAt: number;
  born: LabelSays & PlaceSays;
  purged: boolean;
  root: string;
  label: Array<Holder<LabelSays>>;
  place: Array<Holder<PlaceSays>>;
};

type Lifted = {
  by: TreeRecord["type"];
  entries: DeleteInForce[];
  members: Array<[DeleteInForce, string]>;
};

type DeleteInForce = {
  id: string;
  from?: string;
  putBackBy: Map<string, Set<string>>;
  node: string;
  cascade: Set<string>;
  own: boolean;
  withdraws: boolean;
};

export function replay(
  values: readonly unknown[],
  of: { draft?: string | null } = {},
): TreeProjection {
  return startReplay(values, of).finish();
}

export type WouldTake = { skipped: SkipReason } | { sources: readonly string[] };

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

export type TreeStanding = {
  node(id: string): StandingNode | undefined;
  history(id: string): NodeHistory | undefined;
  changes: ReadonlyMap<string, Change>;
  standingDeletes: ReadonlySet<string>;
  descendants(id: string): string[];
};

export type Replay = {
  push(record: TreeRecord): void;
  wouldTake(record: TreeRecord): WouldTake;
  standing(): TreeStanding;
  finish(): TreeProjection;
};

export function startReplay(
  values: readonly unknown[],
  of: { draft?: string | null } = {},
): Replay {
  const nodes = new Map<string, Working>();
  const skipped: TreeProjection["skipped"] = [];
  const rescued: string[] = [];
  const gone = new Set<string>();
  const reads = values.map(readStored);
  const drafted = new Set(
    of.draft == null
      ? []
      : reads.flatMap((read) =>
          read.ok && read.record.draft === of.draft ? [read.record.carries ?? read.record.id] : [],
        ),
  );
  const ownDelete = (record: TreeRecord) =>
    record.draft !== null ||
    (of.draft != null &&
      (record.fromDraft === of.draft ||
        (record.undoes !== undefined && drafted.has(record.undoes))));
  const purgedDeletes = new Set<string>();
  const purgedAt = new Map<string, number>();
  for (const read of reads)
    if (read.ok && read.record.type === "purge") purgedDeletes.add(read.record.delete);
  const isFinal = (entry: DeleteInForce) =>
    purgedDeletes.has(entry.id) || (entry.from !== undefined && purgedDeletes.has(entry.from));
  let deletes: DeleteInForce[] = [];
  const lifted = new Map<string, Lifted>();

  const placeable = (id: string) => placeIn(nodes, id);

  const lift = (
    record: TreeRecord,
    node: Working,
    how: { index: number } | { ownOnly: boolean },
  ) => {
    const touch = "ownOnly" in how;
    const may = (entry: DeleteInForce) => !isFinal(entry) && (!touch || !how.ownOnly || entry.own);
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
    if (record.type !== "create") lifted.set(record.carries ?? record.id, took);
  };

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

  const changes = new Map<string, Change>();
  const families = new Map<string, Change>();
  const chains = new Map<string, Change[]>();
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
  const parentAfter = (node: Working, flips: readonly Change[]) =>
    turned(node, flips).place.at(-1)?.says.parent ?? node.born.parent;
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
  // Every skip check in step() must precede any mutation so wouldTake stays pure
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
        if (existing.root !== (record.carries ?? record.id)) return skip("duplicate");
        if (dry) return { parent: parentAfter(existing, flipsOf(record)) };
        lift(record, existing, { ownOnly: record.draft !== null });
        take(record, index);
        return;
      }
      if (record.kind === "document" && !isTracked(record.filetype))
        return skip("type-not-editable");
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
    const node = placeable(record.node);
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
          node.lastChangedBy = record.actor;
          return;
        }
        const why = cannotStand(record.node, record.parent);
        if (why) return skip(why);
        if (dry) return { parent: record.parent };
        lift(record, node, { ownOnly: record.draft !== null });
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
        if (readActor(record.actor).kind === "user") node.provisional = false;
        node.lastChangedBy = record.actor;
        return;
      }
      case "delete": {
        if (dry) return { parent: parentAfter(node, flipsOf(record)) };
        const back = record.undoes === undefined ? undefined : lifted.get(record.undoes);
        const withdraws =
          record.draft === null &&
          record.undoes !== undefined &&
          record.fromDraft !== undefined &&
          record.carries === undefined;
        take(record, index);
        if (back) {
          putBack(record, back);
          return;
        }
        deletes.push({
          id: record.id,
          ...(record.carries ? { from: record.carries } : {}),
          putBackBy: new Map(),
          node: record.node,
          cascade: new Set(record.cascade),
          own: ownDelete(record),
          withdraws,
        });
        return;
      }
      case "restore":
        if (dry) return { parent: parentAfter(node, flipsOf(record)) };
        lift(record, node, record.fromDraft === undefined ? { index } : { ownOnly: false });
        take(record, index);
        return;
      case "purge": {
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
      const { children, standing } = stand(nodes, deletes, rescuedTo);
      const sorted = new Map<string, Working[]>();
      const kidsOf = (parent: string) => {
        let kids = sorted.get(parent);
        if (!kids) {
          kids = [...(children.get(parent) ?? [])].sort(compareRankThenId);
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
        ...derive(nodes, deletes, skipped, rescued, gone, rescueFromPurged(nodes, purgedAt)),
        changes,
        inForce: new Set([...changes.values()].flatMap((each) => (each.inForce ? [each.id] : []))),
        dropped: [],
      };
    },
  };
}

type Rescued = ReadonlyMap<string, { parent: string; arrivedAt: number }>;

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

export const lifts = (
  restore: { node: string; undoes?: string },
  entry: { id: string; node: string; from?: string },
) =>
  entry.node === restore.node &&
  (restore.undoes === undefined || entry.id === restore.undoes || entry.from === restore.undoes);

export function placeIn<Node extends { purged: boolean }>(
  nodes: ReadonlyMap<string, Node>,
  id: string,
): Node | undefined {
  const node = nodes.get(id);
  return node && !node.purged ? node : undefined;
}

export type Sets = { label?: Holder<LabelSays>; place?: Holder<PlaceSays> };

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

export function labelOf(
  kind: NodeKind,
  born: LabelSays,
  label: ReadonlyArray<Holder<LabelSays>>,
): LabelSays {
  const filetype = label.findLast((each) => each.says.filetype)?.says.filetype ?? born.filetype;
  const name = label[label.length - 1]?.says.name ?? born.name;
  return { name: shownName(kind, name, filetype), ...(filetype ? { filetype } : {}) };
}

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

type Standing = {
  deleted: boolean;
  keptByChild: boolean;
  source: string;
  hard: boolean;
  absent: boolean;
};

function stand(
  nodes: Map<string, Working>,
  deletes: DeleteInForce[],
  rescuedTo: Rescued,
): { children: Map<string, Working[]>; standing: Map<string, Standing> } {
  const children = new Map<string, Working[]>();
  for (const node of nodes.values()) {
    const parent = rescuedTo.get(node.id)?.parent ?? node.parent;
    const siblings = children.get(parent);
    if (siblings) siblings.push(node);
    else children.set(parent, [node]);
  }
  const ownedBy = new Map<string, DeleteInForce[]>();
  const takenBy = new Map<string, DeleteInForce[]>();
  for (const entry of deletes) {
    ownedBy.set(entry.node, [...(ownedBy.get(entry.node) ?? []), entry]);
    for (const member of entry.cascade)
      if (nodes.has(member)) takenBy.set(member, [...(takenBy.get(member) ?? []), entry]);
  }

  const standing = new Map<string, Standing>();
  const active = new Set<DeleteInForce>();
  type Frame = {
    key: string;
    kids: Working[];
    next: number;
    liveBelow: boolean;
    allAbsent: boolean;
    source: string;
    node?: Working;
  };
  const stack: Frame[] = [];
  const open = (key: string, source: string, node?: Working) =>
    stack.push({
      key,
      kids: children.get(key) ?? [],
      next: 0,
      liveBelow: false,
      allAbsent: true,
      source,
      node,
    });

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
        let hard = false;
        if (mine)
          for (const entry of mine) {
            active.add(entry);
            deleted = true;
            if (!entry.withdraws) hard = true;
          }
        if (cascades)
          for (const entry of cascades)
            if (active.has(entry)) {
              deleted = true;
              if (!entry.withdraws) hard = true;
            }
        standing.set(child.id, {
          deleted,
          keptByChild: false,
          source: frame.source,
          hard,
          absent: false,
        });
        open(child.id, frame.source, child);
        continue;
      }
      stack.pop();
      const node = frame.node;
      if (!node) continue;
      for (const entry of ownedBy.get(node.id) ?? []) active.delete(entry);
      const state = standing.get(node.id) as Standing;
      state.keptByChild = state.deleted && frame.liveBelow;
      state.absent = state.deleted && !state.keptByChild && !state.hard && frame.allAbsent;
      const parent = stack[stack.length - 1];
      if (parent && (!state.deleted || frame.liveBelow)) parent.liveBelow = true;
      if (parent && !state.absent) parent.allAbsent = false;
    }
  }
  return { children, standing };
}

const inForce = (nodes: Map<string, Working>, deletes: DeleteInForce[]) =>
  deletes.filter((entry) => nodes.has(entry.node) && !nodes.get(entry.node)?.purged);

const deletesInTrash = (
  nodes: Map<string, Working>,
  deletes: DeleteInForce[],
  hides: (id: string) => boolean,
) => inForce(nodes, deletes).filter((entry) => [entry.node, ...entry.cascade].some(hides));

const hidden = (standing: ReadonlyMap<string, Standing>, id: string) => {
  const state = standing.get(id);
  return state?.deleted === true && !state.keptByChild;
};

const rootsOf = (entries: DeleteInForce[], counts: (put: ReadonlySet<string>) => boolean) =>
  new Set(
    entries.flatMap((entry) => [
      entry.id,
      entry.from ?? entry.id,
      ...[...entry.putBackBy].flatMap(([root, put]) => (counts(put) ? [root] : [])),
    ]),
  );

function derive(
  nodes: Map<string, Working>,
  deletes: DeleteInForce[],
  skipped: TreeProjection["skipped"],
  rescued: string[],
  gone: ReadonlySet<string>,
  rescuedTo: Rescued,
): Omit<TreeProjection, "dropped" | "changes" | "inForce"> {
  const { children, standing } = stand(nodes, deletes, rescuedTo);
  const absent = (id: string) => standing.get(id)?.absent === true;
  const hides = (id: string) => hidden(standing, id) && !absent(id);
  const parentOf = (node: Working) => rescuedTo.get(node.id)?.parent ?? node.parent;
  const arrivedAt = (node: Working) => rescuedTo.get(node.id)?.arrivedAt ?? node.arrivedAt;
  const suffixes = new Map<string, string>();
  for (const kids of children.values()) {
    const shown = kids
      .filter((kid) => {
        const state = standing.get(kid.id);
        return !kid.purged && state && (!state.deleted || state.keptByChild);
      })
      .sort((a, b) => arrivedAt(a) - arrivedAt(b) || a.createdAt - b.createdAt);
    for (const [id, suffix] of suffixesInArrival(shown)) suffixes.set(id, suffix);
  }

  const out = new Map<string, TreeNode>();
  const history = new Map<string, NodeHistory>();
  for (const node of nodes.values()) {
    if (absent(node.id)) continue;
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
      purged: node.purged,
      ...(node.blob ? { blob: node.blob } : {}),
      createdBy: node.createdBy,
      lastChangedBy: node.lastChangedBy,
      arrival: arrivedAt(node),
    });
  }
  const ordered = new Map<string, TreeNode[]>();
  for (const [parent, kids] of children)
    if (!absent(parent))
      ordered.set(parent, kids.flatMap((kid) => out.get(kid.id) ?? []).sort(compareRankThenId));
  const inTrash = deletesInTrash(nodes, deletes, hides);
  const covered = (entry: DeleteInForce) =>
    [...entry.cascade].filter((member) => {
      if (absent(member)) return false;
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
    hidingDeletes: rootsOf(inTrash, (put) => [...put].some(hides)),
  };
}

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

const isTracked = (type: string | undefined): boolean =>
  type !== undefined && classifyFiletype(type).kind === "tracked";

function schemaOf(type: string): string | null {
  const classification = classifyFiletype(type);
  return classification.kind === "tracked" ? classification.schemaType : null;
}

export function deleteCovering(projection: TreeProjection, id: string): TrashEntry | undefined {
  return deletesCovering(projection, id)[0];
}

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
