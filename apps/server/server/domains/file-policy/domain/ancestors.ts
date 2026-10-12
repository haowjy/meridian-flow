/**
 * The one ancestor matcher (file-access §3.1). Sharing grants and future
 * per-folder agent rules attach to nodes of the file tree and are looked up
 * over a file and its ancestors. Results come nearest first, so the most
 * specific rule is the first match and the best grant is a max over all.
 */
import type { FileFacts, FileNode } from "./types.js";

/** The file itself, then its ancestors, nearest first. */
function nodeChain(facts: Pick<FileFacts, "self" | "ancestors">): FileNode[] {
  return facts.self ? [facts.self, ...facts.ancestors] : [...facts.ancestors];
}

/** Rules attached to the file or an ancestor, nearest first. */
export function matchAncestors<R extends { node: FileNode }>(
  facts: Pick<FileFacts, "self" | "ancestors">,
  rules: readonly R[],
): R[] {
  return nodeChain(facts).flatMap((node) =>
    rules.filter((rule) => rule.node.kind === node.kind && rule.node.id === node.id),
  );
}
