/**
 * Proof code. The replay of tree-log.ts as a state that takes one record at a time.
 *
 * `replay()` runs a list of records from the start and then derives, for every node, whether
 * it is in Trash, whether a deleted folder is kept standing, and the name it shows. This
 * engine holds the same state between records. `push` applies one record to it and `pop`
 * takes the last one back (each push journals what it changed), so a record that belongs
 * before the last few (a live record under a Work's pending ones; under several writers, a
 * record that Yjs places in the middle) costs a pop of those few, the push, and their pushes
 * again. `refresh` then re-derives only the nodes a record could have changed, and returns
 * them: the rows to write.
 *
 * The rules are tree-log.ts's, line for line where they could be; tree-engine.test.ts holds
 * the engine to `replay()` after every step.
 */
import type {
  Actor,
  BlobRef,
  DraftId,
  NodeKind,
  SkipReason,
  TreeNode,
  TreeOp,
  TreeProjection,
} from "./tree-log.js";
import { ROOT } from "./tree-log.js";

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
  arrivedAt: number;
};

type DeleteInForce = {
  id: string;
  from?: string;
  node: string;
  cascade: ReadonlySet<string>;
  own: boolean;
};

type Derived = { deleted: boolean; keptByPending: boolean; kept: boolean; shown: string };

/** What one push changed, so `pop` can take it back and `refresh` knows where to look. */
type Entry = { op: TreeOp; undo: Array<() => void> };

export class TreeEngine {
  private readonly nodes = new Map<string, Working>();
  private readonly kids = new Map<string, Set<string>>();
  private readonly deletes = new Map<string, DeleteInForce>();
  private readonly byTop = new Map<string, Set<string>>();
  private readonly byMember = new Map<string, Set<string>>();
  private readonly pendingOps = new Map<string, Set<string>>();
  private readonly arrivalBefore = new Map<string, number>();
  private skipped: Array<{ op: string; reason: SkipReason }> = [];
  private rescued: string[] = [];
  private readonly journal: Entry[] = [];
  private position = 0;

  private readonly derived = new Map<string, Derived>();
  /** Nodes whose place in Trash may have changed, and nodes placed, named or ranked anew. */
  private readonly dirty = new Set<string>();
  /** Folders whose kept state and whose children's shown names must be looked at again. */
  private readonly dirtyChains = new Set<string>();
  private readonly dirtyGroups = new Set<string>();
  /** Work done, for the proof's cost figures. */
  pushes = 0;
  pops = 0;

  constructor(
    private of: { draft?: DraftId | null; pendingText?: ReadonlySet<string> } = {},
  ) {
    this.nodes.set(ROOT, {
      id: ROOT,
      kind: "folder",
      name: "",
      parent: null,
      rank: "",
      createdBy: "system",
      lastChangedBy: "system",
      createdAt: -1,
      arrivedAt: -1,
    });
    this.derived.set(ROOT, { deleted: false, keptByPending: false, kept: false, shown: "" });
  }

  /** The documents the Work holds pending text of changed; text is not in the list. */
  setPendingText(next: ReadonlySet<string>): void {
    const was = this.of.pendingText ?? new Set<string>();
    for (const id of [...was, ...next]) if (was.has(id) !== next.has(id)) this.dirty.add(id);
    this.of = { ...this.of, pendingText: next };
  }

  get length(): number {
    return this.journal.length;
  }

  idAt(index: number): string | undefined {
    return this.journal[index]?.op.id;
  }

  private isAncestor(maybeAncestor: string, of: string): boolean {
    let at: string | null = of;
    for (let guard = 0; at !== null && guard <= this.nodes.size; guard += 1) {
      if (at === maybeAncestor) return true;
      at = this.nodes.get(at)?.parent ?? null;
    }
    return false;
  }

  private chain(from: string | null): string[] {
    const out: string[] = [];
    let at = from;
    for (let guard = 0; at !== null && guard <= this.nodes.size; guard += 1) {
      out.push(at);
      at = this.nodes.get(at)?.parent ?? null;
    }
    return out;
  }

  private index(map: Map<string, Set<string>>, key: string, id: string, add: boolean) {
    const set = map.get(key) ?? new Set<string>();
    if (add) set.add(id);
    else set.delete(id);
    if (set.size > 0) map.set(key, set);
    else map.delete(key);
  }

  /** Sets or removes a delete in force, keeps the two indexes, and marks what it names. */
  private setDelete(id: string, next: DeleteInForce | undefined, undo: Entry["undo"]) {
    const prev = this.deletes.get(id);
    const write = (record: DeleteInForce | undefined, was: DeleteInForce | undefined) => {
      if (was) {
        this.index(this.byTop, was.node, id, false);
        for (const member of was.cascade) this.index(this.byMember, member, id, false);
        this.dirty.add(was.node);
        for (const member of was.cascade) this.dirty.add(member);
      }
      if (record) {
        this.deletes.set(id, record);
        this.index(this.byTop, record.node, id, true);
        for (const member of record.cascade) this.index(this.byMember, member, id, true);
        this.dirty.add(record.node);
        for (const member of record.cascade) this.dirty.add(member);
      } else this.deletes.delete(id);
    };
    write(next, prev);
    undo.push(() => write(prev, next));
  }

  private place(node: Working, parent: string | null) {
    if (node.parent !== null) this.index(this.kids, node.parent, node.id, false);
    node.parent = parent;
    if (parent !== null) this.index(this.kids, parent, node.id, true);
  }

  /** A node went to, left or changed within `parent`: its folders above and its siblings. */
  private touch(node: string, parent: string | null) {
    this.dirty.add(node);
    if (parent !== null) {
      this.dirtyChains.add(parent);
      this.dirtyGroups.add(parent);
    }
  }

  private pend(op: TreeOp, undo: Entry["undo"]) {
    if (op.draft === null) return;
    const on = this.pendingOps.get(op.node) ?? new Set<string>();
    const before = new Set(on);
    if (op.undoes !== undefined && on.has(op.undoes)) on.delete(op.undoes);
    else on.add(op.id);
    this.pendingOps.set(op.node, on);
    this.dirty.add(op.node);
    undo.push(() => {
      this.pendingOps.set(op.node, before);
      this.dirty.add(op.node);
    });
  }

  private arrival(node: Working, op: TreeOp, index: number, changed: boolean, undo: Entry["undo"]) {
    const keys = [op.id, ...(op.appliedFrom ? [op.appliedFrom] : [])];
    const before = keys.map((key) => [key, this.arrivalBefore.get(key)] as const);
    for (const key of keys) this.arrivalBefore.set(key, node.arrivedAt);
    undo.push(() => {
      for (const [key, was] of before)
        if (was === undefined) this.arrivalBefore.delete(key);
        else this.arrivalBefore.set(key, was);
    });
    const undone = op.undoes === undefined ? undefined : this.arrivalBefore.get(op.undoes);
    if (undone !== undefined) node.arrivedAt = undone;
    else if (changed) node.arrivedAt = index;
  }

  private skip(op: TreeOp, reason: SkipReason, undo: Entry["undo"]) {
    this.skipped.push({ op: op.id, reason });
    undo.push(() => this.skipped.pop());
  }

  /** Applies one record after everything pushed so far. */
  push(op: TreeOp): void {
    this.pushes += 1;
    const undo: Entry["undo"] = [];
    const index = this.position;
    this.position += 1;
    undo.push(() => {
      this.position -= 1;
    });
    this.journal.push({ op, undo });
    switch (op.type) {
      case "create": {
        if (this.nodes.has(op.node)) return this.skip(op, "duplicate", undo);
        const parent = this.nodes.get(op.parent);
        let parentId = op.parent;
        if (!parent || parent.kind !== "folder") {
          parentId = ROOT;
          this.rescued.push(op.id);
          undo.push(() => this.rescued.pop());
        }
        const node: Working = {
          id: op.node,
          kind: op.kind,
          name: op.name,
          parent: null,
          rank: op.rank,
          ...(op.blob ? { blob: op.blob } : {}),
          createdBy: op.actor,
          lastChangedBy: op.actor,
          createdAt: index,
          arrivedAt: op.arrival === undefined ? index : op.arrival - 1e12,
        };
        this.nodes.set(op.node, node);
        this.place(node, parentId);
        this.touch(op.node, parentId);
        undo.push(() => {
          this.place(node, null);
          this.nodes.delete(op.node);
          this.touch(op.node, parentId);
        });
        return;
      }
      case "move": {
        const node = this.nodes.get(op.node);
        if (!node || op.node === ROOT) return this.skip(op, "missing-node", undo);
        const parent = this.nodes.get(op.parent);
        if (!parent) return this.skip(op, "missing-parent", undo);
        if (parent.kind !== "folder") return this.skip(op, "parent-not-folder", undo);
        if (this.isAncestor(op.node, op.parent)) return this.skip(op, "cycle", undo);
        this.pend(op, undo);
        const before = { ...node };
        this.arrival(node, op, index, node.parent !== op.parent, undo);
        const crossing = () => {
          // Whether a deleted folder above the old or the new place takes something of this
          // subtree with it depends on where the subtree is.
          for (const top of [...this.chain(before.parent), ...this.chain(op.parent)])
            for (const id of this.byTop.get(top) ?? [])
              for (const member of this.deletes.get(id)?.cascade ?? [])
                if (member === op.node || this.isAncestor(op.node, member)) this.dirty.add(member);
        };
        crossing();
        this.touch(op.node, before.parent);
        this.place(node, op.parent);
        node.rank = op.rank;
        node.lastChangedBy = op.actor;
        this.touch(op.node, op.parent);
        undo.push(() => {
          crossing();
          this.touch(op.node, node.parent);
          this.place(node, before.parent);
          node.rank = before.rank;
          node.lastChangedBy = before.lastChangedBy;
          node.arrivedAt = before.arrivedAt;
          this.touch(op.node, before.parent);
        });
        return;
      }
      case "rename": {
        const node = this.nodes.get(op.node);
        if (!node || op.node === ROOT) return this.skip(op, "missing-node", undo);
        this.pend(op, undo);
        const before = { ...node };
        this.arrival(node, op, index, node.name !== op.name, undo);
        node.name = op.name;
        node.lastChangedBy = op.actor;
        this.touch(op.node, node.parent);
        undo.push(() => {
          node.name = before.name;
          node.lastChangedBy = before.lastChangedBy;
          node.arrivedAt = before.arrivedAt;
          this.touch(op.node, node.parent);
        });
        return;
      }
      case "delete": {
        if (!this.nodes.has(op.node) || op.node === ROOT)
          return this.skip(op, "missing-node", undo);
        this.setDelete(
          op.id,
          {
            id: op.id,
            ...(op.appliedFrom ? { from: op.appliedFrom } : {}),
            node: op.node,
            cascade: new Set(op.cascade),
            own: op.draft !== null || (this.of.draft != null && op.fromDraft === this.of.draft),
          },
          undo,
        );
        return;
      }
      case "restore": {
        const node = this.nodes.get(op.node);
        if (!node) return this.skip(op, "missing-node", undo);
        const undone = op.undoes;
        for (const id of [...(this.byTop.get(op.node) ?? [])]) {
          const record = this.deletes.get(id);
          if (!record) continue;
          if (undone === undefined || record.id === undone || record.from === undone)
            this.setDelete(id, undefined, undo);
        }
        const arrivedAt = node.arrivedAt;
        node.arrivedAt = index;
        this.touch(op.node, node.parent);
        undo.push(() => {
          node.arrivedAt = arrivedAt;
          this.touch(op.node, node.parent);
        });
        if (undone === undefined)
          for (const top of this.chain(node.parent))
            for (const id of [...(this.byTop.get(top) ?? [])]) {
              const record = this.deletes.get(id);
              if (!record) continue;
              const left = [...record.cascade].filter(
                (member) => member !== op.node && !this.isAncestor(op.node, member),
              );
              if (left.length !== record.cascade.size)
                this.setDelete(id, { ...record, cascade: new Set(left) }, undo);
            }
        return;
      }
    }
  }

  /** Takes back the last `count` records, newest first. */
  pop(count: number): TreeOp[] {
    const out: TreeOp[] = [];
    for (let n = 0; n < count; n += 1) {
      const entry = this.journal.pop();
      if (!entry) break;
      this.pops += 1;
      for (let at = entry.undo.length - 1; at >= 0; at -= 1) (entry.undo[at] as () => void)();
      out.push(entry.op);
    }
    return out.reverse();
  }

  private inForce(node: string, ownOnly: boolean): boolean {
    for (const id of this.byTop.get(node) ?? [])
      if (!ownOnly || this.deletes.get(id)?.own) return true;
    for (const id of this.byMember.get(node) ?? []) {
      const record = this.deletes.get(id);
      if (record && (!ownOnly || record.own) && this.isAncestor(record.node, node)) return true;
    }
    return false;
  }

  /** A deleted folder stands while something inside it, at any depth, is not deleted. */
  private keeps(folder: string): boolean {
    const stack = [folder];
    while (stack.length > 0)
      for (const child of this.kids.get(stack.pop() as string) ?? []) {
        if (!this.derived.get(child)?.deleted) return true;
        stack.push(child);
      }
    return false;
  }

  /**
   * Re-derives Trash, kept folders and shown names for what the records since the last call
   * could have changed. Returns the nodes whose row may differ (a node that no longer exists
   * is among them).
   */
  refresh(): Set<string> {
    const changed = new Set<string>();
    for (const id of this.dirty) {
      const node = this.nodes.get(id);
      if (!node) {
        if (this.derived.delete(id)) changed.add(id);
        continue;
      }
      const raw = this.inForce(id, false);
      const pending =
        (this.pendingOps.get(id)?.size ?? 0) > 0 || (this.of.pendingText?.has(id) ?? false);
      const keptByPending = raw && pending && !this.inForce(id, true);
      const deleted = raw && !keptByPending;
      const was = this.derived.get(id);
      if (!was || was.deleted !== deleted || was.keptByPending !== keptByPending) {
        this.derived.set(id, {
          deleted,
          keptByPending,
          kept: was?.kept ?? false,
          shown: was?.shown ?? node.name,
        });
        if (node.parent !== null) {
          this.dirtyChains.add(node.parent);
          this.dirtyGroups.add(node.parent);
        }
      }
      // What is inside a node decides whether it is kept; its own change may flip that.
      this.dirtyChains.add(id);
      changed.add(id);
    }
    const above = new Set<string>();
    for (const start of this.dirtyChains) for (const id of this.chain(start)) above.add(id);
    for (const id of above) {
      const state = this.derived.get(id);
      if (!state || !this.nodes.has(id)) continue;
      const kept = state.deleted && this.keeps(id);
      if (kept === state.kept) continue;
      state.kept = kept;
      changed.add(id);
      const parent = this.nodes.get(id)?.parent;
      if (parent != null) this.dirtyGroups.add(parent);
    }
    for (const parent of this.dirtyGroups) {
      const shown = [...(this.kids.get(parent) ?? [])]
        .map((id) => this.nodes.get(id) as Working)
        .filter((node) => {
          const state = this.derived.get(node.id);
          return !state?.deleted || state.kept;
        })
        .sort((a, b) => a.arrivedAt - b.arrivedAt || a.createdAt - b.createdAt);
      const names = new Map<string, string>();
      const taken = new Set<string>();
      for (const node of shown) {
        let name = node.name;
        for (let copy = 2; taken.has(name); copy += 1) name = `${node.name} (${copy})`;
        taken.add(name);
        names.set(node.id, name);
      }
      for (const id of this.kids.get(parent) ?? []) {
        const state = this.derived.get(id);
        const node = this.nodes.get(id);
        if (!state || !node) continue;
        const name = names.get(id) ?? node.name;
        if (name === state.shown) continue;
        state.shown = name;
        changed.add(id);
      }
    }
    this.dirty.clear();
    this.dirtyChains.clear();
    this.dirtyGroups.clear();
    return changed;
  }

  /** One node as `replay()` would give it; call after `refresh`. */
  node(id: string): TreeNode | undefined {
    const node = this.nodes.get(id);
    const state = this.derived.get(id);
    if (!node || !state) return undefined;
    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      displayName: state.shown,
      parent: node.parent,
      rank: node.rank,
      trashed: state.deleted && !state.kept,
      keptByChild: state.kept,
      keptByPending: state.keptByPending,
      ...(node.blob ? { blob: node.blob } : {}),
      createdBy: node.createdBy,
      lastChangedBy: node.lastChangedBy,
      arrival: node.arrivedAt,
    };
  }

  /** The whole tree, for comparing with `replay()`. Costs a pass over every node. */
  projection(): TreeProjection {
    const nodes = new Map<string, TreeNode>();
    for (const id of this.nodes.keys()) nodes.set(id, this.node(id) as TreeNode);
    return {
      nodes,
      skipped: [...this.skipped],
      rescued: [...this.rescued],
      deletes: [...this.deletes.values()].map((record) => ({
        id: record.id,
        node: record.node,
        cascade: [...record.cascade],
      })),
    };
  }
}

/**
 * Brings an engine to a sequence of records: pops back to where the two agree and pushes the
 * rest. A record appended at the end is one push. A live record under a Work's pending ones
 * is a pop of the pending ones, one push, and their pushes again.
 */
export function syncEngine(engine: TreeEngine, ops: readonly TreeOp[]): Set<string> {
  let same = 0;
  while (same < engine.length && same < ops.length && engine.idAt(same) === ops[same]?.id)
    same += 1;
  engine.pop(engine.length - same);
  for (const op of ops.slice(same)) engine.push(op);
  return engine.refresh();
}
