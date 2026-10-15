/**
 * D13: whether a model edit's text has been applied is a function of the draft's text. A pending edit
 * part reads `applied` when no review change has it as a member (its text is in the base, which is live's)
 * and `pending` when some change does. Never stored. Under doubt a part reads pending: membership is the
 * classifier's inclusive answer.
 */
import {
  classifyChanges,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  restorationLinks,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";

let schema: ReturnType<typeof buildDocumentSchema> | null = null;

interface PartEffect {
  effect: {
    inserted: readonly { client: number; clock: number; len: number }[];
    deleted: readonly { client: number; clock: number; len: number }[];
  };
}

/** For each part, whether it lies inside a review change of `draft` (the draft room's document). */
export function partsInChanges(draft: Y.Doc, parts: readonly PartEffect[]): boolean[] {
  schema ??= buildDocumentSchema();
  const base = readBlocks(draft.getXmlFragment(REVIEW_BASE_FRAGMENT), schema);
  const text = readBlocks(draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
  const tuple = (r: { client: number; clock: number; len: number }) =>
    [r.client, r.clock, r.len] as [number, number, number];
  const classified = classifyChanges(draft, projectReview(diffBlocks(base, text)), {
    userId: "",
    parts: parts.map(({ effect }) => ({
      threadId: "",
      turnId: "",
      inserted: effect.inserted.map(tuple),
      deleted: effect.deleted.map(tuple),
    })),
    restorations: restorationLinks(draft),
  });
  const inside = parts.map(() => false);
  for (const { members } of classified.values()) for (const i of members) inside[i] = true;
  return inside;
}
