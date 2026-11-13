import {
  type Actor,
  type BlobRef,
  isSourceRoot,
  type NodeKind,
  sourceIdOf,
  sourceRoot,
  type TreeRecord,
} from "./record.js";

export type TreeNode = {
  id: string;
  kind: NodeKind;
  name: string;
  /** The name shown: `name`, or a numbered copy when a sibling already shows that name (rule 4). */
  displayName: string;
  /** A folder's id, or a source root. */
  parent: string;
  /** The source this node is in now, from the top of its parent chain. */
  source: string;
  rank: string;
  /** In Trash: deleted, and nothing not deleted below it keeps it standing. */
  trashed: boolean;
  /** Deleted, but shown because something not deleted is inside (rule 3). */
  keptByChild: boolean;
  /**
   * Deleted in live, but shown in this Work's view because the Work has a pending change to it
   * (rule 7). Review marks it "deleted in live"; Apply leaves the change pending.
   */
  keptByPending: boolean;
  /** Trash emptied: gone for good, and in no Trash entry. */
  purged: boolean;
  blob?: BlobRef;
  createdBy: Actor;
  /** The actor of the record that last changed where it is or what it is called. */
  lastChangedBy: Actor;
  /** Order of arrival under its name, which decides who shows a number (rule 4). */
  arrival: number;
};

export type SkipReason =
  | "cycle"
  | "missing-node"
  | "missing-parent"
  | "parent-not-folder"
  | "duplicate"
  | "purged";

/** One delete still in force: a Trash entry, with what it still takes. */
export type TrashEntry = {
  /** The delete record's id (an applied copy answers to its drafted record's id too, in `from`). */
  id: string;
  from?: string;
  node: string;
  cascade: string[];
};

export type TreeProjection = {
  nodes: Map<string, TreeNode>;
  /** Children of a folder or source root, in display order: by rank, then id. Trashed ones included. */
  children: Map<string, TreeNode[]>;
  /** Records the replay skipped, with why: what a review shows as "couldn't apply". */
  skipped: Array<{ record: string; reason: SkipReason }>;
  /** Creates whose folder was never created in this view: put at the top of their source (rule 6). */
  rescued: string[];
  /** Trash: the deletes still in force. Per view, like the tree. */
  trash: TrashEntry[];
};

type Working = {
  id: string;
  kind: NodeKind;
  name: string;
  parent: string;
  rank: string;
  /** The source it was created in; the shown source is derived from the parent chain. */
  source: string;
  blob?: BlobRef;
  createdBy: Actor;
  lastChangedBy: Actor;
  createdAt: number;
  /** Position of the record that last brought it to its parent under its name: who gets a number. */
  arrivedAt: number;
  purged: boolean;
};

type DeleteInForce = {
  id: string;
  from?: string;
  node: string;
  cascade: Set<string>;
  /** The viewed Work's own delete, pending or already applied. */
  own: boolean;
};

/**
 * Turns records, in replay order, into a tree: the eight rules of the design, section 2.
 * `of.draft` is the Work whose view this is (null for live); `of.pendingText` the documents it
 * holds pending text of, which the list cannot see.
 */
export function replay(
  records: readonly TreeRecord[],
  of: { draft?: string | null; pendingText?: ReadonlySet<string> } = {},
): TreeProjection {
  const nodes = new Map<string, Working>();
  const skipped: TreeProjection["skipped"] = [];
  const rescued: string[] = [];
  const ownDelete = (record: TreeRecord) =>
    record.draft !== null || (of.draft != null && record.fromDraft === of.draft);
  let deletes: DeleteInForce[] = [];
  const pendingOn = new Map<string, Set<string>>();
  // A drafted change and the drafted record that takes it back leave nothing pending.
  const pend = (record: TreeRecord) => {
    if (record.draft === null) return;
    const on = pendingOn.get(record.node) ?? new Set<string>();
    if (record.undoes !== undefined && on.has(record.undoes)) on.delete(record.undoes);
    else on.add(record.id);
    pendingOn.set(record.node, on);
  };

  const isAncestor = (maybeAncestor: string, of: string): boolean => {
    let at: string | undefined = of;
    for (let guard = 0; at !== undefined && guard <= nodes.size; guard += 1) {
      if (at === maybeAncestor) return true;
      at = nodes.get(at)?.parent;
    }
    return false;
  };

  // An Undo puts back the arrival it reverses, so an undone move or rename shows the names it
  // showed before, not a numbered copy.
  const arrivalBefore = new Map<string, number>();
  const arrival = (node: Working, record: TreeRecord, index: number, changed: boolean) => {
    arrivalBefore.set(record.id, node.arrivedAt);
    // A live copy answers to its drafted record's id too, which an opposite drafted after it names.
    if (record.appliedFrom) arrivalBefore.set(record.appliedFrom, node.arrivedAt);
    const undone = record.undoes === undefined ? undefined : arrivalBefore.get(record.undoes);
    if (undone !== undefined) node.arrivedAt = undone;
    else if (changed) node.arrivedAt = index;
  };

  for (const [index, record] of records.entries()) {
    const skip = (reason: SkipReason) => skipped.push({ record: record.id, reason });
    if (record.type === "create") {
      if (nodes.has(record.node)) {
        skip("duplicate");
        continue;
      }
      const parent = nodes.get(record.parent);
      let parentId = record.parent;
      if (!isSourceRoot(record.parent) && parent?.kind !== "folder") {
        // Rule 6: the folder it was made in was never created in this view (its create was
        // discarded concurrently), so the node shows at the top of its source.
        parentId = sourceRoot(record.source);
        rescued.push(record.id);
      }
      nodes.set(record.node, {
        id: record.node,
        kind: record.kind,
        name: record.name,
        parent: parentId,
        rank: record.rank,
        source: record.source,
        ...(record.blob ? { blob: record.blob } : {}),
        createdBy: record.actor,
        lastChangedBy: record.actor,
        createdAt: index,
        arrivedAt: index,
        purged: false,
      });
      continue;
    }
    const node = nodes.get(record.node);
    if (!node) {
      skip("missing-node");
      continue;
    }
    if (node.purged) {
      skip("purged");
      continue;
    }
    switch (record.type) {
      case "move": {
        if (!isSourceRoot(record.parent)) {
          const parent = nodes.get(record.parent);
          if (!parent) {
            skip("missing-parent");
            continue;
          }
          if (parent.kind !== "folder") {
            skip("parent-not-folder");
            continue;
          }
        }
        // Rule 1: a move that would put a folder inside itself is skipped.
        if (isAncestor(record.node, record.parent)) {
          skip("cycle");
          continue;
        }
        pend(record);
        arrival(node, record, index, node.parent !== record.parent);
        node.parent = record.parent;
        node.rank = record.rank;
        node.lastChangedBy = record.actor;
        break;
      }
      case "rename":
        pend(record);
        arrival(node, record, index, node.name !== record.name);
        node.name = record.name;
        node.lastChangedBy = record.actor;
        break;
      case "delete":
        // Two deletes of one node both count: each takes what its author saw.
        deletes.push({
          id: record.id,
          ...(record.appliedFrom ? { from: record.appliedFrom } : {}),
          node: record.node,
          cascade: new Set(record.cascade),
          own: ownDelete(record),
        });
        break;
      case "restore": {
        // Rule 8. A restore that takes one delete back lifts that delete alone, so one
        // author's Undo never reverses another's delete of the same node. A plain restore lifts
        // every delete of the node. Out of a deleted folder either brings back only the node
        // and what is inside it: they leave that folder's delete, and the folder stands holding
        // them (rule 3) with the rest in Trash.
        const undone = record.undoes;
        deletes = deletes.filter((entry) =>
          undone === undefined
            ? entry.node !== record.node
            : !(entry.node === record.node && (entry.id === undone || entry.from === undone)),
        );
        node.arrivedAt = index;
        if (undone === undefined)
          for (const entry of deletes) {
            if (!isAncestor(entry.node, record.node)) continue;
            for (const member of [...entry.cascade])
              if (member === record.node || isAncestor(record.node, member))
                entry.cascade.delete(member);
          }
        break;
      }
      case "purge":
        node.purged = true;
        break;
    }
  }

  return derive(nodes, deletes, pendingOn, of.pendingText ?? new Set(), skipped, rescued);
}

type Standing = { deleted: boolean; keptByChild: boolean; keptByPending: boolean; source: string };

/**
 * One pass over the nodes, parents before children on the way down and children before parents
 * on the way up: what is deleted (rules 2 and 7), which deleted folders stand (rule 3) and the
 * names shown (rule 4). Cost follows the number of nodes and what the deletes name, not depth.
 */
function derive(
  nodes: Map<string, Working>,
  deletes: DeleteInForce[],
  pendingOn: Map<string, Set<string>>,
  pendingText: ReadonlySet<string>,
  skipped: TreeProjection["skipped"],
  rescued: string[],
): TreeProjection {
  const children = new Map<string, Working[]>();
  for (const node of nodes.values()) {
    const siblings = children.get(node.parent);
    if (siblings) siblings.push(node);
    else children.set(node.parent, [node]);
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
  const displayNames = new Map<string, string>();
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
        const mine = ownedBy.get(child.id) ?? [];
        for (const entry of mine) active.add(entry);
        const taken = [...mine, ...(takenBy.get(child.id) ?? [])].filter((entry) =>
          active.has(entry),
        );
        const deleted = taken.length > 0;
        const draftDeleted = taken.some((entry) => entry.own);
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
      // Every child has been finished: number the names shown here, then report upward.
      const shown = frame.kids
        .filter((kid) => {
          const state = standing.get(kid.id);
          return !kid.purged && state && (!state.deleted || state.keptByChild);
        })
        // The node already standing keeps its name; the one that arrived later is numbered.
        .sort((a, b) => a.arrivedAt - b.arrivedAt || a.createdAt - b.createdAt);
      const taken = new Set<string>();
      for (const kid of shown) {
        let name = kid.name;
        for (let copy = 2; taken.has(name); copy += 1) name = `${kid.name} (${copy})`;
        taken.add(name);
        displayNames.set(kid.id, name);
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

  const out = new Map<string, TreeNode>();
  for (const node of nodes.values()) {
    const state = standing.get(node.id) as Standing;
    out.set(node.id, {
      id: node.id,
      kind: node.kind,
      name: node.name,
      displayName: displayNames.get(node.id) ?? node.name,
      parent: node.parent,
      source: state.source,
      rank: node.rank,
      trashed: node.purged || (state.deleted && !state.keptByChild),
      keptByChild: state.keptByChild,
      keptByPending: state.keptByPending,
      purged: node.purged,
      ...(node.blob ? { blob: node.blob } : {}),
      createdBy: node.createdBy,
      lastChangedBy: node.lastChangedBy,
      arrival: node.arrivedAt,
    });
  }
  const ordered = new Map<string, TreeNode[]>();
  for (const [parent, kids] of children)
    ordered.set(parent, kids.map((kid) => out.get(kid.id) as TreeNode).sort(byRankThenId));
  return {
    nodes: out,
    children: ordered,
    skipped,
    rescued,
    trash: deletes
      .filter((entry) => !nodes.get(entry.node)?.purged)
      .map((entry) => ({
        id: entry.id,
        ...(entry.from ? { from: entry.from } : {}),
        node: entry.node,
        cascade: [...entry.cascade],
      })),
  };
}

/** By rank, then id, so equal ranks from concurrent inserts still sort the same everywhere. */
function byRankThenId(a: TreeNode, b: TreeNode): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
