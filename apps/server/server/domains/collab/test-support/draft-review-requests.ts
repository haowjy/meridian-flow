/** Snapshot-owned branch mutations and explicit preview-fenced request envelopes. */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  type createHarness,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./change-trail-postgres-harness.js";
import { captureHistoricalBranchRow } from "./historical-branch-row.js";

type Fixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;
export async function commitBranchEdit(
  fixture: Fixture,
  branchId: string,
  author: {
    source: "agent" | "writer";
    clientId?: number;
    threadId?: typeof THREAD_ID | null;
    toolCallId?: string;
  },
  mutate: (doc: Y.Doc) => void,
) {
  const staged = await fixture.branchCoordinator.readBranch(branchId, async (doc, snapshot) => {
    const clone = createCollabYDoc({ gc: false });
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    return { clone, generation: snapshot.generation };
  });
  try {
    if (author.clientId !== undefined) staged.clone.clientID = author.clientId;
    mutate(staged.clone);
    await fixture.branchCoordinator.commitSegmentRows({
      branchId: branchId,
      sourceDoc: staged.clone,
      expectedGeneration: staged.generation,
      rows: [
        {
          branchId: branchId,
          updateData: await captureHistoricalBranchRow(
            fixture.branchCoordinator,
            branchId,
            staged.clone,
          ),
          source: author.source,
          actorUserId: author.source === "writer" ? USER_ID : null,
          threadId: author.threadId === undefined ? THREAD_ID : author.threadId,
          turnId: author.source === "agent" ? TURN_ID : null,
          wId: null,
          toolCallId: author.toolCallId ?? null,
          updateMeta: null,
        },
      ],
    });
  } finally {
    staged.clone.destroy();
  }
}

export function fencedRequest<T>(
  command: T,
  preview: Pick<
    Extract<DraftPreviewResponse, { status: "active" }>,
    "liveRevisionToken" | "draftRevisionToken" | "operations"
  >,
  operationIds: string[],
) {
  return {
    ...command,
    operationIds,
    memberPartKeys: preview.operations
      .filter((op) => operationIds.includes(op.operationId))
      .flatMap((op) => (op.partKey ? [op.partKey] : [])),
    admissionTokens: [
      ...new Set(
        preview.operations
          .filter((op) => operationIds.includes(op.operationId))
          .map((op) => op.admissionToken),
      ),
    ],
    closureClassIds: [
      ...new Set(
        preview.operations
          .filter((op) => operationIds.includes(op.operationId))
          .map((op) => op.closureClassId),
      ),
    ],
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
  };
}
