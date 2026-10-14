/**
 * D13: whether a model edit's text has been applied is a function of the draft's text. A pending edit
 * part reads `applied` when its inserted or deleted text sits in no review change (its text is in the
 * base, which is live's) and `pending` when it sits inside one. Never stored.
 */
import {
  diffBlocks,
  editsInChanges,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
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
  return editsInChanges(
    draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    projectReview(diffBlocks(base, text)),
    parts.map(({ effect }) => ({
      threadId: "",
      title: "",
      turnId: "",
      at: "",
      inserted: effect.inserted.map(tuple),
      deleted: effect.deleted.map(tuple),
    })),
  );
}
