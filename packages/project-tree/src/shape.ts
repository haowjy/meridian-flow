import { generateKeyBetween } from "fractional-indexing";
import { freeName } from "./names.js";
import { isSourceRoot, type NodeKind } from "./record.js";
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

/**
 * The name a record should carry for a node going under `parent`: `name`, or its numbered copy
 * when a shown sibling already has it, as the author's own copy shows it (design, section 4).
 * The replay numbers only the clashes nobody could see.
 */
export function nameAmong(
  projection: TreeProjection,
  parent: string,
  kind: NodeKind,
  name: string,
  moving?: string,
): string {
  const taken = new Set(
    childrenOf(projection, parent)
      .filter((node) => node.id !== moving)
      .map((node) => node.displayName),
  );
  return freeName(kind, name, taken);
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
 * A canonical string of the tree, for comparing replicas. Without `marks` it leaves out why a
 * deleted node still stands (kept by a child, kept by a pending change): what a writer reads as
 * the tree's shape.
 */
export function fingerprint(projection: TreeProjection, marks = true): string {
  const lines: string[] = [];
  const walk = (parent: string, depth: number) => {
    for (const child of childrenOf(projection, parent, true)) {
      lines.push(
        `${"  ".repeat(depth)}${child.trashed ? "~" : ""}${marks && child.keptByChild ? "!" : ""}${marks && child.keptByPending ? "?" : ""}${child.kind[0]}:${child.displayName}#${child.id}@${child.rank}`,
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
    const names = new Set<string>();
    for (const node of kids) {
      if (node.trashed) continue;
      if (names.has(node.displayName))
        problems.push(`duplicate name ${node.displayName} in ${parent}`);
      names.add(node.displayName);
    }
  }
  if (expectedNodes)
    for (const id of expectedNodes) if (!nodes.has(id)) problems.push(`lost node ${id}`);
  return problems;
}
