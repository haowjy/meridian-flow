/**
 * An Undo's text rule: each change of an edit's recorded delta (an AI write's, or a press's) that
 * still stands in Live is taken out of it, read by content against the delta, never by Yjs item
 * ids: a checkpoint drops the content of deleted items.
 */
import {
  changeStateIn,
  editChanges,
  readDelta,
  type StoredDelta,
  takeOut,
} from "@meridian/agent-edit/content-merge";
import { DIFF_DELETE, DIFF_INSERT, wordDiff } from "@meridian/agent-edit/diff";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { liveView, type View, viewBlock } from "@meridian/suggestions";
import type { Node as PMNode } from "prosemirror-model";

/** The one schema an inverse reads and writes blocks with: nodes of another instance don't compare. */
export const inverseSchema = buildDocumentSchema();

/** `live` with every change of `parts` that stands in it taken out, in order, and the parts that had one. */
export function takeBack<P extends { delta: StoredDelta | null }>(
  live: readonly PMNode[],
  parts: readonly P[],
): { live: readonly PMNode[]; taken: P[] } {
  let blocks = live;
  const taken: P[] = [];
  for (const part of parts) {
    if (!part.delta) continue;
    for (const change of editChanges(inverseSchema, readDelta(inverseSchema, part.delta))) {
      if (changeStateIn(inverseSchema, change, blocks) !== "stands") continue;
      blocks = takeOut(inverseSchema, change, blocks);
      if (!taken.includes(part)) taken.push(part);
    }
  }
  return { live: blocks, taken };
}

/**
 * The words one edit part changed, for the model's list of its edits: what it took out of Live's
 * text and what it put in, each block's runs joined by `…`, blocks by a line. Read from the part's
 * recorded delta, as the edit's view showed it (Live before; after, Live with the write's own
 * suggestions accepted), never from the document: a checkpoint drops the content of deleted items.
 */
export function deltaExcerpt(stored: StoredDelta | null): { before: string; after: string } {
  if (!stored) return { before: "", after: "" };
  const delta = readDelta(inverseSchema, stored);
  const known = changeDrafts(delta.before);
  const draft = [...changeDrafts(delta.after)].find(([id]) => !known.has(id))?.[1] ?? null;
  const text = (block: PMNode, view: View) => viewBlock(block, view)?.textContent ?? "";
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
    for (const [op, run] of wordDiff(text(block, liveView), next ? text(next, { draft }) : ""))
      if (op === DIFF_DELETE) out.push(run);
      else if (op === DIFF_INSERT) put.push(run);
    line(removed, out);
    line(added, put);
  }
  for (const block of after.values()) line(added, [text(block, { draft })].filter(Boolean));
  return { before: removed.join("\n"), after: added.join("\n") };
}

const idOf = (block: PMNode) => block.attrs.id as string;

/** Each suggestion change the blocks carry, by id, with its draft. */
function changeDrafts(blocks: readonly PMNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const note = (attrs: unknown) => {
    const { id, draft } = (attrs ?? {}) as { id?: unknown; draft?: unknown };
    if (typeof id === "string" && typeof draft === "string") out.set(id, draft);
  };
  for (const block of blocks) {
    note(block.attrs.sug);
    block.descendants((node) => {
      note(node.attrs.sug);
      for (const mark of node.marks) note(mark.attrs);
    });
  }
  return out;
}
