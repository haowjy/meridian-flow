import { readDelta, type StoredDelta } from "@meridian/agent-edit/content-merge";
import { wordDiff } from "@meridian/agent-edit/diff";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";

export const inverseSchema = buildDocumentSchema();

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
