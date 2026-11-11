/**
 * Proof-of-concept: a project's file tree as an append-only operation log in one Y.Doc.
 *
 * The Y.Doc stores facts that always merge (an ordered array of operations, and a map of
 * which drafted operations were settled). The tree is a pure function of those facts:
 * replaying the log in Y.Array order, skipping any move that would put a folder inside
 * itself (Kleppmann et al.'s rule). Every replica holds the same array in the same order once
 * synced, so every replica computes the same tree; validity is enforced by the replay, never by
 * rejecting merged state.
 *
 * Drafts live in the same log, tagged with their draft id. A draft's view replays the live
 * operations first and then the draft's unsettled operations, so the draft always reads as
 * "the current live tree plus my changes". Apply appends live copies of the drafted
 * operations at the end of the log (a rebase), which makes the live tree after Apply equal the
 * draft's view just before it.
 */
import { randomUUID } from "node:crypto";
import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";

export const ROOT = "root";

/** A context source as a root folder. Node ids of this form are treated as already existing. */
export function sourceRoot(sourceId: string): string {
  return `source:${sourceId}`;
}
export function isSourceRoot(id: string): boolean {
  return id === ROOT || id.startsWith("source:");
}
export function sourceIdOf(id: string): string | null {
  return id.startsWith("source:") ? id.slice("source:".length) : null;
}

export type NodeKind = "folder" | "document" | "file";
export type DraftId = string;
/** Who did it: "user:<id>" or "agent:<thread>/<turn>". Stamped by whoever authors the op. */
export type Actor = string;
/** A binary file's place in the tree carries a pointer to its bytes, never the bytes. */
export type BlobRef = { storageKey: string; mime: string; size: number };

type OpBase = {
  id: string;
  actor: Actor;
  /** Null for a live operation; the draft's id for a drafted one. */
  draft: DraftId | null;
  /** On a live copy made by Apply: the drafted op it carries. */
  appliedFrom?: string;
  /** On an inverse: the op it undoes. */
  undoes?: string;
  /** On a live copy made by Apply: who applied it. `actor` stays the drafting author. */
  appliedBy?: Actor;
};

export type CreateOp = OpBase & {
  type: "create";
  node: string;
  kind: NodeKind;
  name: string;
  parent: string;
  rank: string;
  blob?: BlobRef;
};
export type MoveOp = OpBase & {
  type: "move";
  node: string;
  parent: string;
  rank: string;
  /** Where the author saw it, for the undo. */
  from: { parent: string; rank: string };
};
export type RenameOp = OpBase & { type: "rename"; node: string; name: string; fromName: string };
/** `cascade` is the subtree the author saw; only those nodes go with it. */
export type DeleteOp = OpBase & { type: "delete"; node: string; cascade: string[] };
export type RestoreOp = OpBase & { type: "restore"; node: string };
/** The node is gone for good: later restore/move of it is skipped, Trash does not list it. */
export type PurgeOp = OpBase & { type: "purge"; node: string };

export type TreeOp = CreateOp | MoveOp | RenameOp | DeleteOp | RestoreOp | PurgeOp;
export type TreeOpInput =
  | Omit<CreateOp, keyof OpBase>
  | Omit<MoveOp, keyof OpBase>
  | Omit<RenameOp, keyof OpBase>
  | Omit<DeleteOp, keyof OpBase>
  | Omit<RestoreOp, keyof OpBase>
  | Omit<PurgeOp, keyof OpBase>;

export type Settlement = "applied" | "discarded";

export type TreeNode = {
  id: string;
  kind: NodeKind;
  name: string;
  /** The name shown: `name`, or a numbered copy when a sibling already shows that name. */
  displayName: string;
  parent: string | null;
  rank: string;
  /** In the trash: deleted, and no live node below it keeps it standing. */
  trashed: boolean;
  /** Deleted, but shown because something not deleted with it is inside. */
  keptByChild: boolean;
  blob?: BlobRef;
  createdBy: Actor;
  /** The op that last changed where it is or what it is called. */
  lastChangedBy: Actor;
};

export type SkipReason =
  | "cycle"
  | "missing-node"
  | "missing-parent"
  | "parent-not-folder"
  | "duplicate"
  | "purged";
export type TreeProjection = {
  nodes: Map<string, TreeNode>;
  /** Ops the replay skipped, with why: what a review shows as "couldn't apply". */
  skipped: Array<{ op: string; reason: SkipReason }>;
  /** Ops whose node had to be placed at the root because its folder was never created. */
  rescued: string[];
};

export type View = { draft: DraftId | null };
export const LIVE: View = { draft: null };

export function opsOf(doc: Y.Doc): Y.Array<TreeOp> {
  return doc.getArray<TreeOp>("ops");
}

export function settlementsOf(doc: Y.Doc): Y.Map<Settlement> {
  return doc.getMap<Settlement>("settled");
}

/** The ops a view replays, in replay order: live ops, then the draft's unsettled ops. */
export function viewOps(doc: Y.Doc, view: View): TreeOp[] {
  const all = opsOf(doc).toArray();
  const live = all.filter((op) => op.draft === null);
  if (view.draft === null) return live;
  const settled = settlementsOf(doc);
  return [...live, ...all.filter((op) => op.draft === view.draft && !settled.has(op.id))];
}

export function materialize(doc: Y.Doc, view: View): TreeProjection {
  return replay(viewOps(doc, view));
}

type Working = {
  id: string;
  kind: NodeKind;
  name: string;
  parent: string | null;
  rank: string;
  blob?: BlobRef;
  createdBy: Actor;
  lastChangedBy: Actor;
  createdAt: number;
  /** Log position of the op that last brought it to its parent under its name: who gets a numbered name. */
  arrivedAt: number;
};

function ensureRoot(nodes: Map<string, Working>, id: string): void {
  if (nodes.has(id) || !isSourceRoot(id)) return;
  nodes.set(id, {
    id,
    kind: "folder",
    name: sourceIdOf(id) ?? "",
    parent: null,
    rank: "",
    createdBy: "system",
    lastChangedBy: "system",
    createdAt: -1,
    arrivedAt: -1,
  });
}

export function replay(ops: readonly TreeOp[]): TreeProjection {
  const nodes = new Map<string, Working>();
  ensureRoot(nodes, ROOT);
  for (const op of ops) {
    if ("parent" in op && typeof op.parent === "string") ensureRoot(nodes, op.parent);
    if (op.type === "move") ensureRoot(nodes, op.from.parent);
  }
  const skipped: TreeProjection["skipped"] = [];
  const rescued: string[] = [];
  const purged = new Set<string>();
  // Delete records keyed by node; restore removes the node's record. Which cascade members go
  // with a delete is decided against the final tree, so the outcome doesn't depend on whether a
  // concurrent move out of the folder replayed before or after the delete.
  const deletes = new Map<string, Set<string>>();

  const isAncestor = (maybeAncestor: string, of: string): boolean => {
    let at: string | null = of;
    for (let guard = 0; at !== null && guard <= nodes.size; guard += 1) {
      if (at === maybeAncestor) return true;
      at = nodes.get(at)?.parent ?? null;
    }
    return false;
  };

  // An undo puts back the arrival it reverses, so an undone move or rename shows the names it
  // showed before, not a numbered copy.
  const arrivalBefore = new Map<string, number>();
  const arrival = (node: Working, op: TreeOp, index: number, changed: boolean) => {
    arrivalBefore.set(op.id, node.arrivedAt);
    // A live copy answers to its drafted op's id too, which an inverse drafted after it names.
    if (op.appliedFrom) arrivalBefore.set(op.appliedFrom, node.arrivedAt);
    const undone = op.undoes === undefined ? undefined : arrivalBefore.get(op.undoes);
    if (undone !== undefined) node.arrivedAt = undone;
    else if (changed) node.arrivedAt = index;
  };

  for (const [index, op] of ops.entries()) {
    switch (op.type) {
      case "create": {
        if (purged.has(op.node) || isSourceRoot(op.node)) {
          skipped.push({ op: op.id, reason: purged.has(op.node) ? "purged" : "duplicate" });
          continue;
        }
        if (nodes.has(op.node)) {
          skipped.push({ op: op.id, reason: "duplicate" });
          continue;
        }
        const parent = nodes.get(op.parent);
        let parentId = op.parent;
        if (!parent || parent.kind !== "folder") {
          // The folder it was made in was never created in this view (its create was discarded
          // concurrently): keep the node, at the root, rather than lose it.
          parentId = ROOT;
          rescued.push(op.id);
        }
        nodes.set(op.node, {
          id: op.node,
          kind: op.kind,
          name: op.name,
          parent: parentId,
          rank: op.rank,
          ...(op.blob ? { blob: op.blob } : {}),
          createdBy: op.actor,
          lastChangedBy: op.actor,
          createdAt: index,
          arrivedAt: index,
        });
        continue;
      }
      case "move": {
        if (purged.has(op.node)) {
          skipped.push({ op: op.id, reason: "purged" });
          continue;
        }
        const node = nodes.get(op.node);
        if (!node || isSourceRoot(op.node)) {
          skipped.push({ op: op.id, reason: "missing-node" });
          continue;
        }
        const parent = nodes.get(op.parent);
        if (!parent) {
          skipped.push({ op: op.id, reason: "missing-parent" });
          continue;
        }
        if (parent.kind !== "folder") {
          skipped.push({ op: op.id, reason: "parent-not-folder" });
          continue;
        }
        if (isAncestor(op.node, op.parent)) {
          skipped.push({ op: op.id, reason: "cycle" });
          continue;
        }
        arrival(node, op, index, node.parent !== op.parent);
        node.parent = op.parent;
        node.rank = op.rank;
        node.lastChangedBy = op.actor;
        continue;
      }
      case "rename": {
        if (purged.has(op.node)) {
          skipped.push({ op: op.id, reason: "purged" });
          continue;
        }
        const node = nodes.get(op.node);
        if (!node || isSourceRoot(op.node)) {
          skipped.push({ op: op.id, reason: "missing-node" });
          continue;
        }
        arrival(node, op, index, node.name !== op.name);
        node.name = op.name;
        node.lastChangedBy = op.actor;
        continue;
      }
      case "delete": {
        if (purged.has(op.node)) {
          skipped.push({ op: op.id, reason: "purged" });
          continue;
        }
        if (!nodes.has(op.node) || isSourceRoot(op.node)) {
          skipped.push({ op: op.id, reason: "missing-node" });
          continue;
        }
        // Two deletes of one node both count: each takes what its author saw.
        const record = deletes.get(op.node) ?? new Set<string>();
        for (const member of op.cascade) record.add(member);
        deletes.set(op.node, record);
        continue;
      }
      case "restore": {
        if (purged.has(op.node)) {
          skipped.push({ op: op.id, reason: "purged" });
          continue;
        }
        if (!nodes.has(op.node)) {
          skipped.push({ op: op.id, reason: "missing-node" });
          continue;
        }
        deletes.delete(op.node);
        const restored = nodes.get(op.node);
        if (restored) restored.arrivedAt = index;
        // Restoring a node also restores the delete of any folder above it, so it shows.
        for (const [deleted] of deletes) if (isAncestor(deleted, op.node)) deletes.delete(deleted);
        continue;
      }
      case "purge": {
        if (purged.has(op.node) || isSourceRoot(op.node) || !nodes.has(op.node)) {
          skipped.push({
            op: op.id,
            reason: purged.has(op.node) ? "purged" : "missing-node",
          });
          continue;
        }
        const dying = nodes.get(op.node);
        const rescueParent = dying?.parent ?? ROOT;
        for (const child of nodes.values()) {
          if (child.parent === op.node) child.parent = rescueParent;
        }
        deletes.delete(op.node);
        nodes.delete(op.node);
        purged.add(op.node);
        continue;
      }
    }
  }

  const deleted = new Set<string>();
  for (const [node, cascade] of deletes) {
    deleted.add(node);
    for (const member of cascade)
      if (nodes.has(member) && isAncestor(node, member)) deleted.add(member);
  }
  // A node nobody deleted keeps every folder above it standing: a concurrent create or move
  // into a deleted folder is never hidden in the trash.
  const keptByChild = new Set<string>();
  for (const node of nodes.values()) {
    if (deleted.has(node.id)) continue;
    let at = node.parent;
    for (let guard = 0; at !== null && guard <= nodes.size; guard += 1) {
      if (deleted.has(at)) keptByChild.add(at);
      at = nodes.get(at)?.parent ?? null;
    }
  }

  const children = new Map<string, Working[]>();
  for (const node of nodes.values()) {
    if (node.parent === null) continue;
    const list = children.get(node.parent) ?? [];
    list.push(node);
    children.set(node.parent, list);
  }
  const displayNames = new Map<string, string>();
  for (const siblings of children.values()) {
    const shown = siblings.filter((node) => !deleted.has(node.id) || keptByChild.has(node.id));
    // The node already standing keeps its name; the one that arrived later is numbered.
    shown.sort((a, b) => a.arrivedAt - b.arrivedAt || a.createdAt - b.createdAt);
    const taken = new Set<string>();
    for (const node of shown) {
      let name = node.name;
      for (let copy = 2; taken.has(name); copy += 1) name = `${node.name} (${copy})`;
      taken.add(name);
      displayNames.set(node.id, name);
    }
  }

  const out = new Map<string, TreeNode>();
  for (const node of nodes.values()) {
    const trashed = deleted.has(node.id) && !keptByChild.has(node.id);
    out.set(node.id, {
      id: node.id,
      kind: node.kind,
      name: node.name,
      displayName: displayNames.get(node.id) ?? node.name,
      parent: node.parent,
      rank: node.rank,
      trashed,
      keptByChild: keptByChild.has(node.id),
      ...(node.blob ? { blob: node.blob } : {}),
      createdBy: node.createdBy,
      lastChangedBy: node.lastChangedBy,
    });
  }
  return { nodes: out, skipped, rescued };
}

/** Children in display order: by rank, then id, so equal ranks from concurrent inserts still sort the same everywhere. */
export function childrenOf(
  projection: TreeProjection,
  parent: string,
  includeTrashed = false,
): TreeNode[] {
  return [...projection.nodes.values()]
    .filter((node) => node.parent === parent && (includeTrashed || !node.trashed))
    .sort((a, b) =>
      a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
}

export function descendantsOf(projection: TreeProjection, node: string): string[] {
  const out: string[] = [];
  const stack = [node];
  const seen = new Set([node]);
  while (stack.length > 0) {
    const at = stack.pop() as string;
    for (const child of projection.nodes.values()) {
      if (child.parent === at && !seen.has(child.id)) {
        seen.add(child.id);
        out.push(child.id);
        stack.push(child.id);
      }
    }
  }
  return out;
}

/** A rank that sorts at `index` among the parent's shown children. */
export function rankAt(
  projection: TreeProjection,
  parent: string,
  index: number,
  moving?: string,
): string {
  const siblings = childrenOf(projection, parent).filter((node) => node.id !== moving);
  const at = Math.max(0, Math.min(index, siblings.length));
  const before = at > 0 ? (siblings[at - 1]?.rank ?? null) : null;
  let after: string | null = siblings[at]?.rank ?? null;
  // Concurrent inserts can leave equal ranks; place after the run of equal ranks.
  if (before !== null && after !== null && after <= before) {
    after = siblings.slice(at).find((node) => node.rank > before)?.rank ?? null;
  }
  return generateKeyBetween(before, after);
}

/**
 * One replica's writer: authors ops against its own current view. In the server-authoritative
 * shape, the server holds the only TreeWriter for the live doc and clients send it intents.
 */
export class TreeWriter {
  private counter = 0;

  constructor(
    readonly doc: Y.Doc,
    private readonly origin: string = "local",
  ) {}

  nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.doc.clientID.toString(36)}-${this.counter}`;
  }

  /** Node ids are production `folders.id` / `documents.id` uuids. */
  nextNodeId(): string {
    return randomUUID();
  }

  view(view: View): TreeProjection {
    return materialize(this.doc, view);
  }

  author(view: View, actor: Actor, input: TreeOpInput, extra: Partial<OpBase> = {}): TreeOp {
    const op = { ...input, id: this.nextId("op"), actor, draft: view.draft, ...extra } as TreeOp;
    this.doc.transact(() => opsOf(this.doc).push([op]), this.origin);
    return op;
  }

  create(
    view: View,
    actor: Actor,
    input: {
      kind: NodeKind;
      name: string;
      parent: string;
      index?: number;
      blob?: BlobRef;
      node?: string;
    },
  ): CreateOp {
    const projection = this.view(view);
    const node = input.node ?? this.nextNodeId();
    return this.author(view, actor, {
      type: "create",
      node,
      kind: input.kind,
      name: input.name,
      parent: input.parent,
      rank: rankAt(projection, input.parent, input.index ?? Number.MAX_SAFE_INTEGER),
      ...(input.blob ? { blob: input.blob } : {}),
    }) as CreateOp;
  }

  move(
    view: View,
    actor: Actor,
    node: string,
    parent: string,
    index = Number.MAX_SAFE_INTEGER,
  ): MoveOp {
    const projection = this.view(view);
    const current = projection.nodes.get(node);
    return this.author(view, actor, {
      type: "move",
      node,
      parent,
      rank: rankAt(projection, parent, index, node),
      from: { parent: current?.parent ?? ROOT, rank: current?.rank ?? "" },
    }) as MoveOp;
  }

  rename(view: View, actor: Actor, node: string, name: string): RenameOp {
    const current = this.view(view).nodes.get(node);
    return this.author(view, actor, {
      type: "rename",
      node,
      name,
      fromName: current?.name ?? "",
    }) as RenameOp;
  }

  delete(view: View, actor: Actor, node: string): DeleteOp {
    const projection = this.view(view);
    const cascade = descendantsOf(projection, node).filter(
      (id) => !projection.nodes.get(id)?.trashed,
    );
    return this.author(view, actor, { type: "delete", node, cascade }) as DeleteOp;
  }

  restore(view: View, actor: Actor, node: string): RestoreOp {
    return this.author(view, actor, { type: "restore", node }) as RestoreOp;
  }

  purge(view: View, actor: Actor, node: string): PurgeOp {
    return this.author(view, actor, { type: "purge", node }) as PurgeOp;
  }

  /**
   * Applies a draft, whole or in part: a live copy of each chosen op (and of the drafted
   * creates it needs) goes at the end of the log, and the drafted ops are marked applied, in
   * one transaction. Copies keep the drafting actor; `appliedBy` is the receipt's second name.
   */
  apply(draft: DraftId, appliedBy: Actor, only?: readonly string[]): TreeOp[] {
    const pending = viewOps(this.doc, { draft }).filter((op) => op.draft === draft);
    const chosen = only
      ? stableSelection(viewOps(this.doc, LIVE), pending, prerequisites(pending, only))
      : new Set(pending.map((op) => op.id));
    const live = this.view(LIVE);
    const copies: TreeOp[] = [];
    for (const op of pending) {
      if (!chosen.has(op.id)) continue;
      const copy = {
        ...op,
        id: this.nextId("op"),
        draft: null,
        appliedFrom: op.id,
        appliedBy,
      } as TreeOp;
      // The undo of a live copy returns to where live had it, not where the draft saw it.
      if (copy.type === "move") {
        const at = live.nodes.get(copy.node);
        if (at?.parent) copy.from = { parent: at.parent, rank: at.rank };
      }
      if (copy.type === "rename") copy.fromName = live.nodes.get(copy.node)?.name ?? copy.fromName;
      copies.push(copy);
    }
    this.doc.transact(() => {
      opsOf(this.doc).push(copies);
      for (const op of pending)
        if (chosen.has(op.id)) settlementsOf(this.doc).set(op.id, "applied");
    }, this.origin);
    return copies;
  }

  /** Discards a draft, whole or in part: the chosen ops and every drafted op that needs them. */
  discard(draft: DraftId, only?: readonly string[]): string[] {
    const pending = viewOps(this.doc, { draft }).filter((op) => op.draft === draft);
    const chosen = only ? dependents(pending, only) : new Set(pending.map((op) => op.id));
    this.doc.transact(() => {
      for (const id of chosen) settlementsOf(this.doc).set(id, "discarded");
    }, this.origin);
    return [...chosen];
  }

  /**
   * Undoes an op in the view it belongs to, by appending its inverse. Refused when something
   * later changed the same fact ("superseded"), as a branch inverse is today.
   */
  undo(view: View, actor: Actor, opId: string): TreeOp | "superseded" | "unknown" {
    const op = opsOf(this.doc)
      .toArray()
      .find((candidate) => candidate.id === opId);
    if (!op) return "unknown";
    const projection = this.view(view);
    const node = projection.nodes.get(op.node);
    if (!node) return "superseded";
    const extra = { undoes: op.id };
    switch (op.type) {
      case "create":
        if (node.trashed) return "superseded";
        return this.author(
          view,
          actor,
          { type: "delete", node: op.node, cascade: descendantsOf(projection, op.node) },
          extra,
        );
      case "move":
        if (node.parent !== op.parent || node.rank !== op.rank) return "superseded";
        if (!op.from.rank) return "superseded";
        if (!projection.nodes.has(op.from.parent) || projection.nodes.get(op.from.parent)?.trashed)
          return "superseded";
        return this.author(
          view,
          actor,
          {
            type: "move",
            node: op.node,
            parent: op.from.parent,
            rank: op.from.rank,
            from: { parent: op.parent, rank: op.rank },
          },
          extra,
        );
      case "rename":
        if (node.name !== op.name) return "superseded";
        return this.author(
          view,
          actor,
          { type: "rename", node: op.node, name: op.fromName, fromName: op.name },
          extra,
        );
      case "delete":
        if (!node.trashed) return "superseded";
        return this.author(view, actor, { type: "restore", node: op.node }, extra);
      case "restore":
        if (node.trashed) return "superseded";
        return this.author(
          view,
          actor,
          { type: "delete", node: op.node, cascade: descendantsOf(projection, op.node) },
          extra,
        );
      case "purge":
        return "superseded";
    }
  }
}

function nodesCreatedBy(ops: readonly TreeOp[]): Map<string, string> {
  const created = new Map<string, string>();
  for (const op of ops) if (op.type === "create") created.set(op.node, op.id);
  return created;
}

function needs(op: TreeOp): string[] {
  if (op.type === "create") return [op.parent];
  if (op.type === "move") return [op.node, op.parent];
  return [op.node];
}

function factOf(op: TreeOp): string {
  if (op.type === "rename") return `name:${op.node}`;
  if (op.type === "move") return `place:${op.node}`;
  if (op.type === "delete" || op.type === "restore") return `presence:${op.node}`;
  if (op.type === "purge") return `purge:${op.node}`;
  return `create:${op.node}`;
}

/**
 * The chosen ops plus the drafted creates they stand on, and the earlier drafted ops on the same
 * fact (applying a second rename brings the first, or the draft would read the first after it).
 */
export function prerequisites(pending: readonly TreeOp[], only: readonly string[]): Set<string> {
  const created = nodesCreatedBy(pending);
  const byId = new Map(pending.map((op) => [op.id, op]));
  const position = new Map(pending.map((op, index) => [op.id, index]));
  const out = new Set<string>();
  const stack = [...only];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const op = byId.get(id);
    if (!op || out.has(id)) continue;
    out.add(id);
    for (const node of needs(op)) {
      const creator = created.get(node);
      if (creator && creator !== id) stack.push(creator);
    }
    const at = position.get(id) ?? 0;
    for (const earlier of pending.slice(0, at))
      if (factOf(earlier) === factOf(op)) stack.push(earlier.id);
  }
  return out;
}

/**
 * A partial Apply must leave the draft's view as it was. Moves can depend on each other in ways
 * the closure doesn't see (a drafted move is valid only after an earlier one), so the selection
 * is checked by replay, and widened to every drafted op up to the last chosen one when it would
 * change the view. That prefix always keeps it, because it replays the same sequence.
 */
export function stableSelection(
  live: readonly TreeOp[],
  pending: readonly TreeOp[],
  chosen: Set<string>,
): Set<string> {
  const before = fingerprint(replay([...live, ...pending]));
  const ordered = [
    ...live,
    ...pending.filter((op) => chosen.has(op.id)),
    ...pending.filter((op) => !chosen.has(op.id)),
  ];
  if (fingerprint(replay(ordered)) === before) return chosen;
  const last = Math.max(...pending.flatMap((op, index) => (chosen.has(op.id) ? [index] : [])));
  return new Set(pending.slice(0, last + 1).map((op) => op.id));
}

/** The chosen ops plus every drafted op that stands on a node one of them creates, transitively. */
export function dependents(pending: readonly TreeOp[], only: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...only];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    const op = pending.find((candidate) => candidate.id === id);
    if (!op) continue;
    out.add(id);
    if (op.type !== "create") continue;
    for (const other of pending)
      if (other.id !== id && needs(other).includes(op.node)) stack.push(other.id);
  }
  return out;
}

/** What breaks a tree; empty when the projection is a valid tree. */
export function treeViolations(
  projection: TreeProjection,
  expectedNodes?: Iterable<string>,
): string[] {
  const problems: string[] = [];
  const { nodes } = projection;
  const roots = [...nodes.values()].filter((node) => node.parent === null);
  if (roots.length === 0) problems.push("roots: (none)");
  for (const root of roots) {
    if (!isSourceRoot(root.id))
      problems.push(`non-source root ${root.id}`);
    if (root.kind !== "folder") problems.push(`root ${root.id} is not a folder`);
  }
  for (const node of nodes.values()) {
    if (node.parent === null) continue;
    const parent = nodes.get(node.parent);
    if (!parent) problems.push(`orphan ${node.id} -> ${node.parent}`);
    else if (parent.kind !== "folder") problems.push(`${node.id} inside non-folder ${parent.id}`);
    let at: string | null = node.id;
    let steps = 0;
    while (at !== null && !isSourceRoot(at) && steps <= nodes.size) {
      at = nodes.get(at)?.parent ?? null;
      steps += 1;
    }
    if (at === null || !isSourceRoot(at)) problems.push(`cycle or detached at ${node.id}`);
    if (!node.trashed && parent?.trashed)
      problems.push(`shown ${node.id} under trashed ${parent.id}`);
  }
  const shownByParent = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    if (node.parent === null || node.trashed) continue;
    const names = shownByParent.get(node.parent) ?? new Set<string>();
    if (names.has(node.displayName))
      problems.push(`duplicate name ${node.displayName} in ${node.parent}`);
    names.add(node.displayName);
    shownByParent.set(node.parent, names);
  }
  if (expectedNodes)
    for (const id of expectedNodes) if (!nodes.has(id)) problems.push(`lost node ${id}`);
  return problems;
}

/** A canonical string of the shown tree, for comparing replicas. */
export function fingerprint(projection: TreeProjection): string {
  const lines: string[] = [];
  const walk = (parent: string, depth: number) => {
    if (depth > projection.nodes.size) return;
    for (const child of childrenOf(projection, parent, true)) {
      lines.push(
        `${"  ".repeat(depth)}${child.trashed ? "~" : ""}${child.keptByChild ? "!" : ""}${child.kind[0]}:${child.displayName}#${child.id}@${child.rank}`,
      );
      walk(child.id, depth + 1);
    }
  };
  const roots = [...projection.nodes.values()]
    .filter((node) => node.parent === null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const root of roots) {
    lines.push(`#${root.id}`);
    walk(root.id, 0);
  }
  return lines.join("\n");
}

type YItem = {
  id: { client: number; clock: number };
  length: number;
  deleted: boolean;
  content: { getContent(): unknown[] };
  right: YItem | null;
};

/** Records whose Yjs item clock is below `stateVector` for that client. The list has no deletes. */
export function recordsAsOf(doc: Y.Doc, stateVector: Uint8Array): TreeOp[] {
  const sv = Y.decodeStateVector(stateVector);
  const out: TreeOp[] = [];
  let item = (opsOf(doc) as unknown as { _start: YItem | null })._start;
  while (item) {
    const next = sv.get(item.id.client) ?? 0;
    if (!item.deleted) {
      const content = item.content.getContent();
      for (let i = 0; i < content.length; i += 1) {
        if (item.id.clock + i < next) out.push(content[i] as TreeOp);
      }
    }
    item = item.right;
  }
  return out;
}

export type NodeNetChange = {
  node: string;
  created?: { name: string; parent: string; actor: Actor };
  renamed?: { from: string; to: string; actors: Actor[] };
  moved?: { from: { parent: string; rank: string }; to: { parent: string; rank: string }; actors: Actor[] };
  deleted?: { actors: Actor[] };
  restored?: { actors: Actor[] };
  purged?: { actors: Actor[] };
};

/** Fold records since a vector into one net change per node. */
export function netChangesSince(since: readonly TreeOp[], all: readonly TreeOp[]): NodeNetChange[] {
  const sinceIds = new Set(since.map((op) => op.id));
  const added = all.filter((op) => !sinceIds.has(op.id));
  const byNode = new Map<string, NodeNetChange>();
  const touch = (node: string): NodeNetChange => {
    const existing = byNode.get(node);
    if (existing) return existing;
    const created: NodeNetChange = { node };
    byNode.set(node, created);
    return created;
  };
  for (const op of added) {
    const row = touch(op.node);
    switch (op.type) {
      case "create":
        row.created = { name: op.name, parent: op.parent, actor: op.actor };
        break;
      case "rename": {
        const prev = row.renamed;
        row.renamed = {
          from: prev?.from ?? op.fromName,
          to: op.name,
          actors: [...(prev?.actors ?? []), op.actor],
        };
        break;
      }
      case "move": {
        const prev = row.moved;
        row.moved = {
          from: prev?.from ?? op.from,
          to: { parent: op.parent, rank: op.rank },
          actors: [...(prev?.actors ?? []), op.actor],
        };
        break;
      }
      case "delete": {
        const actors = [...(row.deleted?.actors ?? []), op.actor];
        row.deleted = { actors };
        delete row.restored;
        break;
      }
      case "restore": {
        const actors = [...(row.restored?.actors ?? []), op.actor];
        row.restored = { actors };
        delete row.deleted;
        break;
      }
      case "purge": {
        const actors = [...(row.purged?.actors ?? []), op.actor];
        row.purged = { actors };
        break;
      }
    }
  }
  return [...byNode.values()];
}

function parentFirst(nodes: Iterable<TreeNode>): TreeNode[] {
  const list = [...nodes].filter((node) => !isSourceRoot(node.id));
  const have = new Set(list.map((node) => node.id));
  const placed = new Set([...nodes].filter((n) => isSourceRoot(n.id)).map((n) => n.id));
  const out: TreeNode[] = [];
  let guard = 0;
  while (out.length < list.length && guard < list.length + 2) {
    guard += 1;
    for (const node of list) {
      if (placed.has(node.id)) continue;
      if (node.parent === null || placed.has(node.parent) || !have.has(node.parent ?? "")) {
        placed.add(node.id);
        out.push(node);
      }
    }
  }
  return out;
}

/**
 * A fresh Y.Doc whose list is one create per surviving node (parents first), a delete for
 * what is in Trash, and every unsettled drafted record copied as is. Purged nodes are gone.
 */
export function checkpointTree(doc: Y.Doc): Y.Doc {
  const live = materialize(doc, LIVE);
  const fresh = new Y.Doc({ gc: false });
  const writer = new TreeWriter(fresh);
  for (const node of parentFirst(live.nodes.values())) {
    writer.author(
      LIVE,
      node.createdBy,
      {
        type: "create",
        node: node.id,
        kind: node.kind,
        name: node.name,
        parent: node.parent ?? ROOT,
        rank: node.rank,
        ...(node.blob ? { blob: node.blob } : {}),
      },
      { id: writer.nextId("op") },
    );
    if (node.lastChangedBy !== node.createdBy) {
      writer.author(
        LIVE,
        node.lastChangedBy,
        { type: "rename", node: node.id, name: node.name, fromName: node.name },
        { id: writer.nextId("op") },
      );
    }
  }
  for (const node of live.nodes.values()) {
    if (!node.trashed) continue;
    writer.author(
      LIVE,
      node.lastChangedBy,
      {
        type: "delete",
        node: node.id,
        cascade: descendantsOf(live, node.id).filter((id) => live.nodes.get(id)?.trashed),
      },
      { id: writer.nextId("op") },
    );
  }
  const settled = settlementsOf(doc);
  const unsettled = opsOf(doc)
    .toArray()
    .filter((op) => op.draft !== null && !settled.has(op.id));
  if (unsettled.length > 0) {
    fresh.transact(() => {
      opsOf(fresh).push(unsettled);
    }, writer["origin"]);
  }
  return fresh;
}
