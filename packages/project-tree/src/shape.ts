import { entrySegment } from "@meridian/contracts/protocol";
import { generateKeyBetween } from "fractional-indexing";
import { isSourceRoot } from "./record.js";
import type { TreeNode, TreeProjection } from "./replay.js";

export function childrenOf(
  projection: TreeProjection,
  parent: string,
  includeTrashed = false,
): TreeNode[] {
  const kids = projection.children.get(parent) ?? [];
  return includeTrashed ? kids : kids.filter((node) => !node.trashed);
}

export function descendantsOf(
  projection: { children: { get(parent: string): readonly { id: string }[] | undefined } },
  node: string,
): string[] {
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

export function segmentOf(node: Pick<TreeNode, "name" | "suffix">): string {
  return entrySegment(node.name, node.suffix);
}

export function pathOf(projection: TreeProjection, node: TreeNode): string {
  const segments: string[] = [];
  for (let at: TreeNode | undefined = node; at; ) {
    segments.unshift(segmentOf(at));
    at = isSourceRoot(at.parent) ? undefined : projection.nodes.get(at.parent);
  }
  return `/${segments.join("/")}`;
}

export function rankAmong(ranks: readonly string[], index: number): string {
  const at = Math.max(0, Math.min(index, ranks.length));
  const before = at > 0 ? (ranks[at - 1] ?? null) : null;
  let after: string | null = ranks[at] ?? null;
  if (before !== null && after !== null && after <= before) {
    after = ranks.slice(at).find((rank) => rank > before) ?? null;
  }
  return generateKeyBetween(before, after);
}

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

export function fingerprint(projection: TreeProjection, marks = true): string {
  const lines: string[] = [];
  const walk = (parent: string, depth: number) => {
    for (const child of childrenOf(projection, parent, true)) {
      lines.push(
        `${"  ".repeat(depth)}${child.trashed ? "~" : ""}${marks && child.keptByChild ? "!" : ""}${child.kind[0]}:${segmentOf(child)}#${child.id}@${child.rank}`,
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
