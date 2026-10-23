/** Content-only Work draft seeds, independent of live's Yjs identity. */
import {
  DRAFT_SERVER_CLIENT_ID,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import {
  blockItemIdKey,
  getBlockItemId,
  getTopLevelXmlBlocks,
} from "@meridian/agent-edit/integration";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DraftSeedRecord } from "./draft-store.js";

export function seedDraftState(
  live: Y.Doc,
  liveRoom: string | null,
  livePosition: number,
): { state: Buffer; stateVector: Buffer; seed: DraftSeedRecord | null } {
  const schema = buildDocumentSchema();
  const blocks = readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
  const draft = createCollabYDoc({ gc: false });
  try {
    draft.clientID = DRAFT_SERVER_CLIENT_ID;
    draft.transact(() => {
      writeBlocks(draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, blocks);
      writeBlocks(draft.getXmlFragment(REVIEW_BASE_FRAGMENT), schema, blocks);
    });
    const liveBlocks = getTopLevelXmlBlocks(live);
    const draftBlocks = getTopLevelXmlBlocks(draft);
    const sourceRoom = liveRoom;
    const origins =
      sourceRoom && liveBlocks.length > 0 && liveBlocks.length === draftBlocks.length
        ? Object.fromEntries(
            draftBlocks.map((block, index) => [
              blockItemIdKey(getBlockItemId(block)),
              blockItemIdKey(getBlockItemId(liveBlocks[index])),
            ]),
          )
        : null;
    return {
      state: Buffer.from(Y.encodeStateAsUpdate(draft)),
      stateVector: Buffer.from(Y.encodeStateVector(draft)),
      seed:
        origins && sourceRoom
          ? {
              origins,
              liveRoom: sourceRoom,
              liveSnapshot: Buffer.from(Y.encodeSnapshotV2(Y.snapshot(live))),
              draftSnapshot: Buffer.from(Y.encodeSnapshotV2(Y.snapshot(draft))),
              liveAttribution: {
                state: Buffer.from(Y.encodeStateAsUpdate(live)),
                position: livePosition,
              },
            }
          : null,
    };
  } finally {
    draft.destroy();
  }
}
