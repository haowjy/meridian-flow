/** The review frame a writer's room shows for a draft branch: change groups and the room snapshot. */
import {
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
} from "@meridian/agent-edit/diff";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";

const schema = buildDocumentSchema();

/** The ids a `changes` Apply names and the `Y.snapshot` of the state those ids were read from. */
export function reviewFrameOf(doc: Y.Doc) {
  const base = readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema);
  const draft = readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
  return {
    snapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString("base64"),
    groups: projectReview(diffBlocks(base, draft)).groups,
  };
}

export function reviewFrameOfState(state: Uint8Array) {
  const doc = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(doc, state);
    return reviewFrameOf(doc);
  } finally {
    doc.destroy();
  }
}
