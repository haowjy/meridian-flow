/**
 * An Undo's text rule: each change of an AI edit's recorded delta that still stands in Live is
 * taken out of it, read by content against the edit's delta, never by Yjs item ids.
 */
import {
  changeStateIn,
  editChanges,
  readDelta,
  type StoredDelta,
  takeOut,
} from "@meridian/agent-edit/content-merge";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
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
