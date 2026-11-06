/** Word deltas for durable change trails, over the shared counter in `@meridian/agent-edit`. */

import { type WordDelta, wordDeltaBetweenTexts } from "@meridian/agent-edit/diff";
import { bodyFromHashline } from "./trail-read-kernel.js";

/** Normalizes captured protocol hashlines to the prose writers saw before diffing. */
export function wordDeltaBetweenHashlines(
  beforeSerialized: string | null,
  afterSerialized: string | null,
): WordDelta {
  const before = bodyFromHashline(beforeSerialized);
  const after = bodyFromHashline(afterSerialized);
  return wordDeltaBetweenTexts(
    before.status === "available" ? before.markdown : "",
    after.status === "available" ? after.markdown : "",
  );
}
