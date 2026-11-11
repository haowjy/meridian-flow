/** Generate a mixed history of tree operations against a TreeWriter. */
import {
  childrenOf,
  LIVE,
  type TreeNode,
  type TreeOp,
  TreeWriter,
  type View,
} from "./tree-log.js";

const NAMES = ["Ch", "Notes", "Arc", "Map", "Scene", "Draft", "Ref"];

export function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length) % items.length] as T;
}

function shown(writer: TreeWriter, view: View, parent: string): TreeNode[] {
  return childrenOf(writer.view(view), parent, false);
}

function foldersOf(writer: TreeWriter, view: View, root: string): TreeNode[] {
  const out: TreeNode[] = [];
  const stack = [root];
  const proj = writer.view(view);
  while (stack.length) {
    const at = stack.pop() as string;
    for (const child of childrenOf(proj, at, false)) {
      if (child.kind === "folder") {
        out.push(child);
        stack.push(child.id);
      }
    }
  }
  return out;
}

function nodesOf(writer: TreeWriter, view: View, root: string, includeTrashed = false): TreeNode[] {
  const proj = writer.view(view);
  return [...proj.nodes.values()].filter(
    (node) => node.parent !== null && (includeTrashed || !node.trashed),
  );
}

function depthOf(proj: ReturnType<TreeWriter["view"]>, node: string): number {
  let depth = 0;
  let at: string | null = node;
  while (at && depth < 32) {
    const parent = proj.nodes.get(at)?.parent ?? null;
    if (!parent) break;
    at = parent;
    depth += 1;
  }
  return depth;
}

export type MixOpts = {
  root: string;
  actor?: string;
  targetFolders?: number;
  maxDepth?: number;
  drafts?: string[];
};

/**
 * Author one mixed operation. Returns false when the tree had nothing to do.
 * Mix: mostly create/rename/move/reorder; some delete/restore; optional draft ops.
 */
export function oneOp(writer: TreeWriter, rand: () => number, opts: MixOpts): boolean {
  const actor = opts.actor ?? "user:writer";
  const drafts = opts.drafts ?? [];
  const useDraft = drafts.length > 0 && rand() < 0.25;
  const view: View = useDraft ? { draft: pick(rand, drafts) } : LIVE;
  const proj = writer.view(view);
  const folders = foldersOf(writer, view, opts.root);
  const living = nodesOf(writer, view, opts.root);
  const trashed = [...proj.nodes.values()].filter((n) => n.trashed);
  const parents = [opts.root, ...folders.map((f) => f.id)];
  const maxDepth = opts.maxDepth ?? 5;
  const folderCount = folders.length;
  const wantFolders = opts.targetFolders ?? 150;

  const roll = rand();
  try {
    if (roll < 0.45 || living.length === 0) {
      const parent = pick(rand, parents);
      if (depthOf(proj, parent) >= maxDepth) return false;
      const asFolder = folderCount < wantFolders && rand() < 0.2;
      writer.create(view, actor, {
        kind: asFolder ? "folder" : "document",
        name: `${pick(rand, NAMES)}${Math.floor(rand() * 80)}`,
        parent,
      });
      return true;
    }
    if (roll < 0.62 && living.length > 0) {
      const node = pick(rand, living);
      writer.rename(view, actor, node.id, `${pick(rand, NAMES)}${Math.floor(rand() * 80)}`);
      return true;
    }
    if (roll < 0.82 && living.length > 0) {
      const node = pick(rand, living);
      const parent = pick(rand, parents);
      if (parent === node.id) return false;
      if (depthOf(proj, parent) >= maxDepth && node.kind === "folder") return false;
      const siblings = shown(writer, view, parent);
      const index = Math.floor(rand() * (siblings.length + 1));
      writer.move(view, actor, node.id, parent, index);
      return true;
    }
    if (roll < 0.93 && living.length > 4) {
      const node = pick(rand, living);
      writer.delete(view, actor, node.id);
      return true;
    }
    if (trashed.length > 0) {
      writer.restore(view, actor, pick(rand, trashed).id);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function fillTree(
  writer: TreeWriter,
  rand: () => number,
  opts: MixOpts & { nodes: number },
): void {
  let guard = 0;
  while (nodesOf(writer, LIVE, opts.root).length < opts.nodes && guard < opts.nodes * 8) {
    guard += 1;
    oneOp(writer, rand, { ...opts, drafts: [] });
  }
}

export function fillRecords(
  writer: TreeWriter,
  rand: () => number,
  opts: MixOpts & { records: number },
): void {
  let guard = 0;
  const start = writer.doc.getArray("ops").length;
  while (writer.doc.getArray("ops").length - start < opts.records && guard < opts.records * 6) {
    guard += 1;
    oneOp(writer, rand, opts);
  }
}

/**
 * Build a large tree without replaying. Records go into a plain array and are
 * pushed a thousand at a time (one Yjs push per record is quadratic).
 */
export function bulkGenerate(
  writer: TreeWriter,
  opts: { root: string; nodes: number; records: number; drafts: string[]; actor?: string },
): void {
  const actor = opts.actor ?? "user:writer";
  const folderTarget = Math.max(8, Math.round(opts.nodes / 20));
  const folders: string[] = [opts.root];
  const living: string[] = [];
  let n = 0;
  const rankAt = (i: number) => `a${i.toString(36).padStart(6, "0")}`;
  const batch: TreeOp[] = [];
  const flush = () => {
    if (batch.length) writer.doc.getArray<TreeOp>("ops").push(batch.splice(0));
  };
  const push = (input: Parameters<TreeWriter["author"]>[2], draft: string | null = null) => {
    n += 1;
    batch.push({ ...input, id: `bulk-${n}`, actor, draft } as TreeOp);
    if (batch.length >= 1000) flush();
  };
  for (let i = 0; i < opts.nodes; i += 1) {
    const parent = folders[Math.min(folders.length - 1, Math.floor(i / 20))] ?? opts.root;
    const asFolder = folders.length < folderTarget && i % 20 === 0;
    const node = writer.nextNodeId();
    push({
      type: "create",
      node,
      kind: asFolder ? "folder" : "document",
      name: `${asFolder ? "F" : "D"}${i}`,
      parent,
      rank: rankAt(i),
    });
    living.push(node);
    if (asFolder) folders.push(node);
  }
  let extra = 0;
  while (n < opts.records && extra < opts.records) {
    extra += 1;
    const node = living[extra % living.length]!;
    const kind = extra % 7;
    if (kind === 0) {
      push({ type: "rename", node, name: `R${extra}`, fromName: `n${extra}` });
    } else if (kind === 1) {
      const parent = folders[extra % folders.length]!;
      push({
        type: "move",
        node,
        parent,
        rank: rankAt(opts.nodes + extra),
        from: { parent: opts.root, rank: "a0" },
      });
    } else if (kind === 2 && extra % 11 === 0) {
      push({ type: "delete", node, cascade: [] });
      if (extra % 22 === 0) push({ type: "restore", node });
    } else {
      const parent = folders[extra % folders.length]!;
      const made = writer.nextNodeId();
      push({
        type: "create",
        node: made,
        kind: extra % 5 === 0 ? "folder" : "document",
        name: `X${extra}`,
        parent,
        rank: rankAt(opts.nodes + extra),
      });
      living.push(made);
      if (extra % 5 === 0) folders.push(made);
    }
  }
  const draftBudget = Math.min(300, Math.max(50, Math.round(opts.records / 100)));
  for (const draft of opts.drafts) {
    for (let i = 0; i < draftBudget; i += 1) {
      const parent = folders[(i + 3) % folders.length]!;
      const node = living[(i + 7) % living.length]!;
      if (i % 4 === 0) {
        const made = writer.nextNodeId();
        push(
          {
            type: "create",
            node: made,
            kind: i % 8 === 0 ? "folder" : "document",
            name: `${draft}-N${i}`,
            parent,
            rank: rankAt(10_000_000 + i),
          },
          draft,
        );
        if (i % 8 === 0) folders.push(made);
        living.push(made);
      } else if (i % 4 === 1) {
        push({ type: "rename", node, name: `${draft}-R${i}`, fromName: "x" }, draft);
      } else if (i % 4 === 2) {
        push(
          {
            type: "move",
            node,
            parent,
            rank: rankAt(20_000_000 + i),
            from: { parent: opts.root, rank: "a0" },
          },
          draft,
        );
      } else if (i % 8 === 7) {
        push({ type: "delete", node, cascade: [] }, draft);
      }
    }
  }
  flush();
}
