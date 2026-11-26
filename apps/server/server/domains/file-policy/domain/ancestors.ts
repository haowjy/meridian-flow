import type { FileFacts, FileNode } from "./types.js";

function nodeChain(facts: Pick<FileFacts, "self" | "ancestors">): FileNode[] {
  return facts.self ? [facts.self, ...facts.ancestors] : [...facts.ancestors];
}

export function matchAncestors<R extends { node: FileNode }>(
  facts: Pick<FileFacts, "self" | "ancestors">,
  rules: readonly R[],
): R[] {
  return nodeChain(facts).flatMap((node) =>
    rules.filter((rule) => rule.node.kind === node.kind && rule.node.id === node.id),
  );
}
