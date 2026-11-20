/**
 * A Discard and its Restore as text. A Discard merges the review base's side of the chosen changes
 * into the draft and records what it took out as a delta (draft side before, base side after); a
 * Restore reads that delta backwards, change by change, and merges back each change that still
 * stands. A change the writer has written over since stays out, and the draft's words stand.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";
import { applySpanPatches } from "../diff/compose.js";
import { blocksEqual } from "../diff/equal.js";
import { diffBlocks } from "../diff/hunks.js";
import { composeGroups, projectReview } from "../diff/review.js";
import { contentMerge } from "./merge.js";
import {
  captureDelta,
  type EditDelta,
  editChanges,
  type StoredDelta,
  standsIn,
  takeOut,
} from "./stands.js";

/**
 * `text` with the changes of Changes named by `ids` (all of them for "all") set back to `base`,
 * and the delta of what that took out; null when nothing was taken. An id that names no change
 * there throws `UnknownChangeError`. With `seen` (the base and text the ids were read from) the ids name the
 * changes there, and what setting them back did to that text is merged into `text`: a change the
 * writer has written over since stays, the rest goes.
 */
export function discardChanges(
  schema: Schema,
  base: readonly PMNode[],
  text: readonly PMNode[],
  ids: "all" | readonly string[],
  seen?: { base: readonly PMNode[]; text: readonly PMNode[] },
): { text: readonly PMNode[]; delta: StoredDelta } | null {
  const at = seen ?? { base, text };
  const projection = projectReview(diffBlocks(at.base, at.text));
  const chosen = ids === "all" ? projection.groups.map((group) => group.id) : ids;
  const taken = applySpanPatches(
    at.text,
    composeGroups(schema, projection, chosen, "discard"),
    "draft",
  );
  const next =
    seen && !blocksEqual(seen.text, text)
      ? contentMerge(schema, seen.text, taken, text).blocks
      : taken;
  const delta = captureDelta(text, next);
  return delta ? { text: next, delta } : null;
}

/** `text` with every change of the Discard's delta that still stands put back, and how many of its changes there were. */
export function restoreChanges(
  schema: Schema,
  delta: EditDelta,
  text: readonly PMNode[],
): { text: readonly PMNode[]; brought: number; total: number } {
  const changes = editChanges(schema, delta);
  let blocks = text;
  let brought = 0;
  for (const change of changes)
    if (standsIn(schema, change, blocks)) {
      blocks = takeOut(schema, change, blocks);
      brought++;
    }
  return { text: blocks, brought, total: changes.length };
}
