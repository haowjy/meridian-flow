import { entrySegment, idHex, readSegment } from "@meridian/contracts/protocol";
import { generateKeyBetween } from "fractional-indexing";
import { isSourceRoot } from "./record.js";
import type { TreeNode, TreeProjection } from "./replay.js";

/** Children in display order (rank, then id). Trashed ones only when asked. */
export function childrenOf(
  projection: TreeProjection,
  parent: string,
  includeTrashed = false,
): TreeNode[] {
  const kids = projection.children.get(parent) ?? [];
  return includeTrashed ? kids : kids.filter((node) => !node.trashed);
}

/** Every node below `node`, trashed ones included. */
export function descendantsOf(projection: TreeProjection, node: string): string[] {
  const out: string[] = [];
  const stack = [node];
  while (stack.length > 0) {
    for (const child of projection.children.get(stack.pop() as string) ?? []) {
      out.push(child.id);
      stack.push(child.id);
    }
  }
  return out;
}

/** A node's path segment: its name, and a later twin's `~` suffix (rule 14). */
export function segmentOf(node: Pick<TreeNode, "name" | "suffix">): string {
  return entrySegment(node.name, node.suffix);
}

/** A node's path in its source (`/Arc/Kael~460c`), from its segments and its folders'. */
export function pathOf(projection: TreeProjection, node: TreeNode): string {
  const segments: string[] = [];
  for (let at: TreeNode | undefined = node; at; ) {
    segments.unshift(segmentOf(at));
    at = isSourceRoot(at.parent) ? undefined : projection.nodes.get(at.parent);
  }
  return `/${segments.join("/")}`;
}

/** What a path walk reads of a node: a replay's node, or any catalog shaped like one. */
export type Walkable = Pick<TreeNode, "id" | "kind" | "name" | "suffix" | "trashed">;

/**
 * The shown child a path segment reaches. With a `~` suffix, the one whose id's hex digits begin
 * with it (the lowest id, should a suffix shortened by hand fit two), whatever name is in front;
 * a suffix that reaches none reads as the name in front, so a writer and a reader take a stale or
 * made-up `~id` the same way. By name, the child of that name that carries no suffix.
 *
 * `folder` reads a folder level of a path: only folders answer, and when the plain twin of the
 * name is a document, the folder of that name with the lowest id does (`Arc/x` reaches the folder
 * `Arc~922e` beside a document `Arc`). The SQL walk (`nodesAt`) reads the same.
 */
export function childAtSegment<N extends Walkable>(
  children: readonly N[],
  segment: string,
  level?: "folder",
): N | undefined {
  const { name, suffix } = readSegment(segment);
  let byId: N | undefined;
  let plain: N | undefined;
  let named: N | undefined;
  for (const child of children) {
    if (child.trashed || (level === "folder" && child.kind !== "folder")) continue;
    if (suffix !== undefined && idHex(child.id).startsWith(suffix)) {
      if (!byId || child.id < byId.id) byId = child;
    } else if (child.name === name) {
      if (child.suffix === undefined) plain = child;
      else if (level === "folder" && (!named || child.id < named.id)) named = child;
    }
  }
  return byId ?? plain ?? named;
}

/** A rank that sorts at `index` among sibling `ranks` (in display order). */
export function rankAmong(ranks: readonly string[], index: number): string {
  const at = Math.max(0, Math.min(index, ranks.length));
  const before = at > 0 ? (ranks[at - 1] ?? null) : null;
  let after: string | null = ranks[at] ?? null;
  // Concurrent inserts can leave equal ranks; place after the run of equal ranks.
  if (before !== null && after !== null && after <= before) {
    after = ranks.slice(at).find((rank) => rank > before) ?? null;
  }
  return generateKeyBetween(before, after);
}

/** A rank that sorts at `index` among the parent's shown children. */
export function rankAt(
  projection: TreeProjection,
  parent: string,
  index: number,
  moving?: string,
): string {
  return rankAmong(
    childrenOf(projection, parent)
      .filter((node) => node.id !== moving)
      .map((node) => node.rank),
    index,
  );
}

/**
 * A canonical string of the tree, for comparing replicas. Without `marks` it leaves out why a
 * deleted node still stands (kept by a child, kept by a pending change): what a writer reads as
 * the tree's shape.
 */
export function fingerprint(projection: TreeProjection, marks = true): string {
  const lines: string[] = [];
  const walk = (parent: string, depth: number) => {
    for (const child of childrenOf(projection, parent, true)) {
      lines.push(
        `${"  ".repeat(depth)}${child.trashed ? "~" : ""}${marks && child.keptByChild ? "!" : ""}${marks && child.keptByPending ? "?" : ""}${child.kind[0]}:${segmentOf(child)}#${child.id}@${child.rank}`,
      );
      walk(child.id, depth + 1);
    }
  };
  for (const root of [...projection.children.keys()].filter(isSourceRoot).sort()) {
    lines.push(root);
    walk(root, 1);
  }
  return lines.join("\n");
}

/** What breaks a tree; empty when the projection is a valid tree. */
export function treeViolations(
  projection: TreeProjection,
  expectedNodes?: Iterable<string>,
): string[] {
  const problems: string[] = [];
  const { nodes } = projection;
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parent);
    if (!parent && !isSourceRoot(node.parent)) problems.push(`orphan ${node.id} -> ${node.parent}`);
    else if (parent && parent.kind !== "folder")
      problems.push(`${node.id} inside non-folder ${parent.id}`);
    let at: string | undefined = node.id;
    for (let steps = 0; at !== undefined && !isSourceRoot(at) && steps <= nodes.size; steps += 1)
      at = nodes.get(at)?.parent;
    if (at === undefined || !isSourceRoot(at)) problems.push(`cycle or detached at ${node.id}`);
    if (!node.trashed && parent?.trashed)
      problems.push(`shown ${node.id} under trashed ${parent.id}`);
  }
  for (const [parent, kids] of projection.children) {
    const segments = new Set<string>();
    for (const node of kids) {
      if (node.trashed) continue;
      const segment = segmentOf(node);
      if (segments.has(segment)) problems.push(`duplicate segment ${segment} in ${parent}`);
      segments.add(segment);
    }
  }
  if (expectedNodes)
    for (const id of expectedNodes) if (!nodes.has(id)) problems.push(`lost node ${id}`);
  return problems;
}
