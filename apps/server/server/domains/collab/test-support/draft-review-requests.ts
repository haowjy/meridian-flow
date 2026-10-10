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
    await fixture.branchCoordinator.commitSyncFromDoc({
      branchId,
      sourceDoc: staged.clone,
      expectedGeneration: staged.generation,
      source: author.source,
      actorUserId: author.source === "writer" ? USER_ID : null,
      threadId: author.threadId === undefined ? THREAD_ID : author.threadId,
      turnId: author.source === "agent" ? TURN_ID : null,
      wId: null,
      toolCallId: author.toolCallId ?? null,
      updateMeta: null,
    });
  } finally {
    staged.clone.destroy();
  }
}

export function fencedRequest<T>(
  command: T,
  preview: Pick<
    Extract<DraftPreviewResponse, { status: "active" }>,
    "liveRevisionToken" | "draftRevisionToken"
  >,
  operationIds: string[],
) {
  return {
    ...command,
    operationIds,
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
  };
}
