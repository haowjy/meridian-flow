/** Content-only Work draft seeds, independent of live's Yjs identity. */
import {
  DRAFT_SERVER_CLIENT_ID,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export function seedDraftState(live: Y.Doc): { state: Buffer; stateVector: Buffer } {
  const schema = buildDocumentSchema();
  const blocks = readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
  const draft = createCollabYDoc({ gc: false });
  try {
    draft.clientID = DRAFT_SERVER_CLIENT_ID;
    draft.transact(() => {
      writeBlocks(draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, blocks);
      writeBlocks(draft.getXmlFragment(REVIEW_BASE_FRAGMENT), schema, blocks);
    });
    return {
      state: Buffer.from(Y.encodeStateAsUpdate(draft)),
      stateVector: Buffer.from(Y.encodeStateVector(draft)),
    };
  } finally {
    draft.destroy();
  }
}
