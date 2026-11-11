/**
 * Copy of `../tree-log.ts` for the migration proof, with the parent's keptByPending /
 * applyLanding rule, plus:
 *
 * - `source:<context_sources.id>` ids are existing root folders (parent `null`).
 * - `Actor` may be `"unrecorded"`. Ops may carry `at`; creates may carry `fileType`
 *   and `contentPurgedAt`.
 */
import { generateKeyBetween } from "fractional-indexing";
import type * as Y from "yjs";

export const ROOT = "root";

export type NodeKind = "folder" | "document" | "file";
export type DraftId = string;
/** Who did it: "user:<id>", "agent:<thread>/<turn>", or "unrecorded" when today's rows hold none. */
export type Actor = string;

export function isSourceRoot(id: string): boolean {
  return id.startsWith("source:");
}

export function sourceRoot(sourceId: string): string {
  return `source:${sourceId}`;
}
/** A binary file's place in the tree carries a pointer to its bytes, never the bytes. */
export type BlobRef = { storageKey: string; mime: string; size: number };

type OpBase = {
  id: string;
  actor: Actor;
  /** Null for a live operation; the draft's id for a drafted one. */
  draft: DraftId | null;
  /** When today's row holds a time for this fact; omitted when it holds none. */
  at?: string | null;
  /** On a live copy made by Apply: the drafted op it carries. */
  appliedFrom?: string;
  /** On an inverse: the op it undoes. */
  undoes?: string;
  /** On a live copy made by Apply: who applied it. `actor` stays the drafting author. */
  appliedBy?: Actor;
  /** On a live copy made by Apply: the draft it came from. */
  fromDraft?: DraftId;
};

export type CreateOp = OpBase & {
  type: "create";
  node: string;
  kind: NodeKind;
  name: string;
  parent: string;
  rank: string;
  blob?: BlobRef;
  fileType?: string;
  contentPurgedAt?: string | null;
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

export type TreeOp = CreateOp | MoveOp | RenameOp | DeleteOp | RestoreOp;
export type TreeOpInput =
  | Omit<CreateOp, keyof OpBase>
  | Omit<MoveOp, keyof OpBase>
  | Omit<RenameOp, keyof OpBase>
  | Omit<DeleteOp, keyof OpBase>
  | Omit<RestoreOp, keyof OpBase>;

/** `undone` is set on a live copy whose Apply was taken back: the replay leaves it out. */
export type Settlement = "applied" | "discarded" | "undone";

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
  /**
   * Deleted in live, but shown in this Work's view because the Work has a pending change to it
   * (a drafted move or rename, or drafted text). Review marks it "deleted in live", and Apply
   * leaves the change pending until the node is restored.
   */
  keptByPending: boolean;
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
  | "duplicate";
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
  const settled = settlementsOf(doc);
  const live = all.filter((op) => op.draft === null && settled.get(op.id) !== "undone");
  if (view.draft === null) return live;
  return [...live, ...all.filter((op) => op.draft === view.draft && !settled.has(op.id))];
}

/** `pendingText`: documents this Work holds a pending text draft of, which the list cannot see. */
export function materialize(
  doc: Y.Doc,
  view: View,
  pendingText?: ReadonlySet<string>,
): TreeProjection {
  return replay(viewOps(doc, view), { draft: view.draft, pendingText });
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

export function replay(
  ops: readonly TreeOp[],
  /** The Work whose view this is (null for live), and the documents it holds pending text of. */
  of: { draft?: DraftId | null; pendingText?: ReadonlySet<string> } = {},
): TreeProjection {
  const pendingText = of.pendingText ?? new Set<string>();
  // A delete is the viewed Work's own while it is pending and after it was applied.
  const ownDelete = (op: TreeOp) =>
    op.draft !== null || (of.draft != null && op.fromDraft === of.draft);
  const sourceFolder = (id: string): Working => ({
    id,
    kind: "folder",
    name: "",
    parent: null,
    rank: "",
    createdBy: "system",
    lastChangedBy: "system",
    createdAt: -1,
    arrivedAt: -1,
  });
  const nodes = new Map<string, Working>([[ROOT, sourceFolder(ROOT)]]);
  const ensureSource = (id: string | null | undefined) => {
    if (id && isSourceRoot(id) && !nodes.has(id)) nodes.set(id, sourceFolder(id));
  };
  const skipped: TreeProjection["skipped"] = [];
  const rescued: string[] = [];
  // Delete records keyed by node; restore removes the node's record. Which cascade members go
  // with a delete is decided against the final tree, so the outcome doesn't depend on whether a
  // concurrent move out of the folder replayed before or after the delete.
  const deletes = new Map<string, Set<string>>();
  // The same record of deletes, for drafted deletes only, and the nodes a drafted record other
  // than a delete acts on: together they say which live deletes the draft's own work outlives.
  const draftDeletes = new Map<string, Set<string>>();
  const pendingOps = new Map<string, Set<string>>();
  // A drafted change and the drafted record that takes it back leave nothing pending.
  const pend = (op: TreeOp) => {
    if (op.draft === null) return;
    const on = pendingOps.get(op.node) ?? new Set<string>();
    if (op.undoes !== undefined && on.has(op.undoes)) on.delete(op.undoes);
    else on.add(op.id);
    pendingOps.set(op.node, on);
  };

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
        if (nodes.has(op.node)) {
          skipped.push({ op: op.id, reason: "duplicate" });
          continue;
        }
        ensureSource(op.parent);
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
        const node = nodes.get(op.node);
        if (!node || op.node === ROOT || isSourceRoot(op.node)) {
          skipped.push({ op: op.id, reason: "missing-node" });
          continue;
        }
        ensureSource(op.parent);
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
        pend(op);
        arrival(node, op, index, node.parent !== op.parent);
        node.parent = op.parent;
        node.rank = op.rank;
        node.lastChangedBy = op.actor;
        continue;
      }
      case "rename": {
        const node = nodes.get(op.node);
        if (!node || op.node === ROOT || isSourceRoot(op.node)) {
          skipped.push({ op: op.id, reason: "missing-node" });
          continue;
        }
        pend(op);
        arrival(node, op, index, node.name !== op.name);
        node.name = op.name;
        node.lastChangedBy = op.actor;
        continue;
      }
      case "delete": {
        if (!nodes.has(op.node) || op.node === ROOT || isSourceRoot(op.node)) {
          skipped.push({ op: op.id, reason: "missing-node" });
          continue;
        }
        // Two deletes of one node both count: each takes what its author saw.
        const record = deletes.get(op.node) ?? new Set<string>();
        for (const member of op.cascade) record.add(member);
        deletes.set(op.node, record);
        if (ownDelete(op)) {
          const drafted = draftDeletes.get(op.node) ?? new Set<string>();
          for (const member of op.cascade) drafted.add(member);
          draftDeletes.set(op.node, drafted);
        }
        continue;
      }
      case "restore": {
        if (!nodes.has(op.node)) {
          skipped.push({ op: op.id, reason: "missing-node" });
          continue;
        }
        deletes.delete(op.node);
        draftDeletes.delete(op.node);
        const restored = nodes.get(op.node);
        if (restored) restored.arrivedAt = index;
        // Restoring a node also restores the delete of any folder above it, so it shows.
        for (const [deleted] of deletes)
          if (isAncestor(deleted, op.node)) {
            deletes.delete(deleted);
            draftDeletes.delete(deleted);
          }
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
  // A live delete does not take a node this Work has a pending change to, unless the Work
  // deleted it too: the node stays in the Work's view, marked, as today's overlay keeps it.
  const draftDeleted = new Set<string>();
  for (const [node, cascade] of draftDeletes) {
    draftDeleted.add(node);
    for (const member of cascade)
      if (nodes.has(member) && isAncestor(node, member)) draftDeleted.add(member);
  }
  const keptByPending = new Set<string>();
  const pendingOn = [...pendingOps].flatMap(([node, on]) => (on.size > 0 ? [node] : []));
  for (const node of [...pendingOn, ...pendingText])
    if (deleted.has(node) && !draftDeleted.has(node)) {
      deleted.delete(node);
      keptByPending.add(node);
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
      keptByPending: keptByPending.has(node.id),
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
    const node = input.node ?? this.nextId("n");
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

  /**
   * Applies a draft, whole or in part: a live copy of each chosen op (and of the drafted
   * creates it needs) goes at the end of the log, and the drafted ops are marked applied, in
   * one transaction. Copies keep the drafting actor; `appliedBy` is the receipt's second name.
   */
  apply(draft: DraftId, appliedBy: Actor, only?: readonly string[]): TreeOp[] {
    return this.applyLanding(draft, appliedBy, only).copies;
  }

  private applyChosen(draft: DraftId, appliedBy: Actor, chosen: ReadonlySet<string>): TreeOp[] {
    const pending = viewOps(this.doc, { draft }).filter((op) => op.draft === draft);
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
        fromDraft: draft,
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

  /**
   * Applies what can land and leaves the rest drafted. Two kinds of record cannot land: one the
   * draft's view skips (a move that would put a folder inside itself), and a move or rename of
   * a node live has in Trash (the view keeps it standing only because this change is pending).
   * They stay pending with whatever stands on them, so the writer can fix the cause and apply
   * again, or discard them. `blocked` is true when the records that could land are tied to one
   * that cannot (dependent moves) so that taking them alone would change the draft's view:
   * then nothing is taken.
   */
  applyLanding(
    draft: DraftId,
    appliedBy: Actor,
    only?: readonly string[],
  ): { copies: TreeOp[]; left: TreeOp[]; blocked: boolean } {
    const view = this.view({ draft });
    const pending = viewOps(this.doc, { draft }).filter((op) => op.draft === draft);
    const skipped = new Set(view.skipped.map((skip) => skip.op));
    const cannot = pending.filter(
      (op) =>
        skipped.has(op.id) ||
        ((op.type === "move" || op.type === "rename") && view.nodes.get(op.node)?.keptByPending),
    );
    const leftIds = dependents(pending, cannot.map((op) => op.id));
    const wanted = only ? prerequisites(pending, only) : new Set(pending.map((op) => op.id));
    const landing = new Set([...wanted].filter((id) => !leftIds.has(id)));
    if (landing.size === 0) return { copies: [], left: pending, blocked: false };
    const live = viewOps(this.doc, LIVE);
    // The draft's view must read the same after: take the selection if it keeps it, else the
    // drafted records up to the last chosen one less what cannot land, else nothing.
    let chosen: Set<string> | undefined;
    if (keepsView(live, pending, landing)) chosen = landing;
    else {
      const last = Math.max(...pending.flatMap((op, at) => (landing.has(op.id) ? [at] : [])));
      const prefix = new Set(
        pending
          .slice(0, last + 1)
          .map((op) => op.id)
          .filter((id) => !leftIds.has(id)),
      );
      if (keepsView(live, pending, prefix)) chosen = prefix;
    }
    if (!chosen) return { copies: [], left: pending, blocked: true };
    const taken = chosen;
    const copies = this.applyChosen(draft, appliedBy, taken);
    return { copies, left: pending.filter((op) => !taken.has(op.id)), blocked: false };
  }

  /**
   * Takes an Apply back: its live copies leave the replay and the drafted records are pending
   * again, so live and the draft both read as they did before it. Refused once a later live
   * record acts on a node the Apply touched or on anything it created.
   */
  undoApply(copies: readonly TreeOp[]): "undone" | "superseded" {
    const all = opsOf(this.doc).toArray();
    const settled = settlementsOf(this.doc);
    const ids = new Set(copies.map((copy) => copy.id));
    // Built on: a later live record acts on a node the Apply acted on, or puts something into a
    // folder the Apply created. A later change inside a folder the Apply only moved is not.
    const actedOn = new Set(copies.map((copy) => copy.node));
    const created = new Set(copies.flatMap((copy) => (copy.type === "create" ? [copy.node] : [])));
    const last = Math.max(...all.flatMap((op, index) => (ids.has(op.id) ? [index] : [])));
    for (const op of all.slice(last + 1)) {
      if (op.draft !== null || settled.get(op.id) === "undone" || ids.has(op.id)) continue;
      if (actedOn.has(op.node)) return "superseded";
      if ((op.type === "create" || op.type === "move") && created.has(op.parent))
        return "superseded";
    }
    this.doc.transact(() => {
      for (const copy of copies) {
        settled.set(copy.id, "undone");
        if (copy.appliedFrom) settled.delete(copy.appliedFrom);
      }
    }, this.origin);
    return "undone";
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
 * Whether applying `chosen` leaves the draft's view as it was: the view of live plus every
 * pending record, against the view after the chosen ones have become live copies.
 */
export function keepsView(
  live: readonly TreeOp[],
  pending: readonly TreeOp[],
  chosen: ReadonlySet<string>,
): boolean {
  const draft = pending[0]?.draft ?? null;
  const before = fingerprint(replay([...live, ...pending], { draft }));
  const after = [
    ...live,
    ...pending
      .filter((op) => chosen.has(op.id))
      .map((op) => ({ ...op, draft: null, fromDraft: draft ?? undefined }) as TreeOp),
    ...pending.filter((op) => !chosen.has(op.id)),
  ];
  return fingerprint(replay(after, { draft })) === before;
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
  for (const root of roots) {
    if (root.id !== ROOT && !isSourceRoot(root.id))
      problems.push(`roots: ${roots.map((n) => n.id).join(",")}`);
    else if (root.kind !== "folder") problems.push(`root not folder ${root.id}`);
  }
  if (roots.length === 0) problems.push("roots:");
  for (const node of nodes.values()) {
    if (node.parent === null) continue;
    const parent = nodes.get(node.parent);
    if (!parent) problems.push(`orphan ${node.id} -> ${node.parent}`);
    else if (parent.kind !== "folder") problems.push(`${node.id} inside non-folder ${parent.id}`);
    let at: string | null = node.id;
    let steps = 0;
    while (at !== null && at !== ROOT && !isSourceRoot(at) && steps <= nodes.size) {
      at = nodes.get(at)?.parent ?? null;
      steps += 1;
    }
    if (at !== ROOT && (at === null || !isSourceRoot(at)))
      problems.push(`cycle or detached at ${node.id}`);
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
        `${"  ".repeat(depth)}${child.trashed ? "~" : ""}${child.keptByChild ? "!" : ""}${child.keptByPending ? "?" : ""}${child.kind[0]}:${child.displayName}#${child.id}@${child.rank}`,
      );
      walk(child.id, depth + 1);
    }
  };
  const roots = [...projection.nodes.values()]
    .filter((node) => node.parent === null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const root of roots) walk(root.id, 0);
  return lines.join("\n");
}
