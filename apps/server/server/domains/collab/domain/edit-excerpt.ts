/** An AI write's recorded delta in words, and the schema an inverse reads blocks with. */
import { readDelta, type StoredDelta } from "@meridian/agent-edit/content-merge";
import { wordDiff } from "@meridian/agent-edit/diff";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";

/** The one schema an inverse reads and writes blocks with: nodes of another instance don't compare. */
export const inverseSchema = buildDocumentSchema();

/**
 * The words one edit part changed, for the model's list of its edits: what it took out and what it
 * put in, each block's runs joined by `…`, blocks by a line. Read from the part's recorded delta,
 * never from the document, which has moved on since.
 */
export function deltaExcerpt(stored: StoredDelta | null): { before: string; after: string } {
  if (!stored) return { before: "", after: "" };
  const delta = readDelta(inverseSchema, stored);
  const after = new Map(delta.after.map((block) => [idOf(block), block]));
  const removed: string[] = [];
  const added: string[] = [];
  const line = (into: string[], runs: string[]) => {
    if (runs.length) into.push(runs.join(" … "));
  };
  for (const block of delta.before) {
    const next = after.get(idOf(block));
    after.delete(idOf(block));
    const out: string[] = [];
    const put: string[] = [];
    for (const { kind, text } of wordDiff(block.textContent, next?.textContent ?? ""))
      if (kind === "removed") out.push(text);
      else if (kind === "added") put.push(text);
    line(removed, out);
    line(added, put);
  }
  for (const block of after.values()) line(added, [block.textContent].filter(Boolean));
  return { before: removed.join("\n"), after: added.join("\n") };
}

const idOf = (block: PMNode) => block.attrs.id as string;
