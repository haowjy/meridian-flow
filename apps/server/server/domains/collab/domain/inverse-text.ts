/**
 * An Undo's text rule: each change of an edit's recorded delta (an AI write's, or a press's) that
 * still stands in Live is taken out of it, read by content against the delta.
 */
import {
  readDelta,
  type StoredDelta,
  takeBack as takeBackChanges,
} from "@meridian/agent-edit/content-merge";
import { DIFF_DELETE, DIFF_INSERT, wordDiff } from "@meridian/agent-edit/diff";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";

/** The one schema an inverse reads and writes blocks with: nodes of another instance don't compare. */
export const inverseSchema = buildDocumentSchema();

/** `live` with every change of `parts` that stands in it taken out, in order, and the parts that had one. */
export function takeBack<P extends { delta: StoredDelta | null }>(
  live: readonly PMNode[],
  parts: readonly P[],
): { live: readonly PMNode[]; taken: P[] } {
  const { text, taken } = takeBackChanges(inverseSchema, live, parts);
  return { live: text, taken };
}

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
    for (const [op, run] of wordDiff(block.textContent, next?.textContent ?? ""))
      if (op === DIFF_DELETE) out.push(run);
      else if (op === DIFF_INSERT) put.push(run);
    line(removed, out);
    line(added, put);
  }
  for (const block of after.values()) line(added, [block.textContent].filter(Boolean));
  return { before: removed.join("\n"), after: added.join("\n") };
}

const idOf = (block: PMNode) => block.attrs.id as string;
