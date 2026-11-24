/**
 * What an AI edit changed, as its receipt stores it: the blocks it changed, before and after, with
 * one unchanged block either side. The card and the model's list of its edits read it; every Undo
 * of the edit runs on design §2's rule (`@meridian/document-model`), never on this content.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";
import { blocksEqual } from "../diff/equal.js";

/** The blocks an edit's part changed, before and after, with one unchanged block either side. */
export interface EditDelta {
  before: readonly PMNode[];
  after: readonly PMNode[];
}

/** An edit's delta as stored: ProseMirror JSON. */
export interface StoredDelta {
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
}

/** What a write did to the text: the blocks it changed, before and after, with one block either side. Null when it changed nothing. */
export function captureDelta(
  before: readonly PMNode[],
  after: readonly PMNode[],
): StoredDelta | null {
  if (blocksEqual(before, after)) return null;
  const cut = narrow(before, after);
  return {
    before: cut.before.map((block) => block.toJSON()),
    after: cut.after.map((block) => block.toJSON()),
  };
}

export function readDelta(schema: Schema, stored: StoredDelta): EditDelta {
  return {
    before: stored.before.map((block) => schema.nodeFromJSON(block)),
    after: stored.after.map((block) => schema.nodeFromJSON(block)),
  };
}

function narrow(before: readonly PMNode[], after: readonly PMNode[]): EditDelta {
  let head = 0;
  while (head < before.length && head < after.length && blocksEqual([before[head]], [after[head]]))
    head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    blocksEqual([before[before.length - 1 - tail]], [after[after.length - 1 - tail]])
  )
    tail++;
  const from = Math.max(0, head - 1);
  return {
    before: before.slice(from, Math.min(before.length, before.length - tail + 1)),
    after: after.slice(from, Math.min(after.length, after.length - tail + 1)),
  };
}
