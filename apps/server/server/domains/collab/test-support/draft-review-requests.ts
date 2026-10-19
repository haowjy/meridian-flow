/** Snapshot-owned draft edits and explicit preview-fenced request envelopes. */
import { randomUUID } from "node:crypto";
import type { BranchCommandId, BranchId, UserId, WorkId } from "@meridian/contracts";
import type { BranchCommandKind } from "@meridian/contracts/branches";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DraftReviewApi } from "../contracts.js";
import { type BranchCommandEnvelope, commandDigest } from "../domain/branch-commands.js";
import {
  type createHarness,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./change-trail-postgres-harness.js";
import { captureHistoricalDraftRow } from "./historical-draft-row.js";

type Fixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;
export async function commitDraftEdit(
  fixture: Fixture,
  draftId: string,
  author: {
    source: "agent" | "writer";
    clientId?: number;
    threadId?: typeof THREAD_ID | null;
    toolCallId?: string;
  },
  mutate: (doc: Y.Doc) => void,
) {
  const staged = await fixture.draftCoordinator.readDraft(draftId, async (doc, snapshot) => {
    const clone = createCollabYDoc({ gc: false });
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    return { clone, generation: snapshot.generation };
  });
  try {
    if (author.clientId !== undefined) staged.clone.clientID = author.clientId;
    mutate(staged.clone);
    await fixture.draftCoordinator.commitSegmentRows({
      draftId: draftId,
      sourceDoc: staged.clone,
      expectedGeneration: staged.generation,
      rows: [
        {
          draftId: draftId,
          updateData: await captureHistoricalDraftRow(
            fixture.draftCoordinator,
            draftId,
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

/** A fresh command envelope for facade-level suites; the route builds its own from the body. */
export function testEnvelope(input: {
  workId: WorkId;
  kind: BranchCommandKind;
  branchId: BranchId | null;
  userId?: UserId;
  commandId?: BranchCommandId;
  body?: unknown;
}): BranchCommandEnvelope {
  const accountId = input.userId ?? (USER_ID as UserId);
  return {
    commandId: input.commandId ?? (randomUUID() as BranchCommandId),
    workId: input.workId,
    accountId,
    kind: input.kind,
    branchId: input.branchId,
    digest: commandDigest({
      accountId,
      projectId: "",
      workId: input.workId,
      kind: input.kind,
      selectors: { branchId: input.branchId },
      body: input.body ?? null,
    }),
  };
}

export function reviewDriver(
  review: DraftReviewApi,
  scope: { workId?: WorkId; userId?: UserId } = {},
) {
  const workId = scope.workId ?? (WORK_ID as WorkId);
  const userId = scope.userId ?? (USER_ID as UserId);
  const body = (outcome: Awaited<ReturnType<DraftReviewApi["discardItem"]>>) =>
    outcome.kind === "result" ? outcome.result : outcome;
  async function resolved(documentId: string) {
    const found = await review.resolveItemByDocument({ workId, documentId: documentId as never });
    if (!found) throw new Error(`No review item for ${documentId}`);
    return found;
  }
  const driver = {
    resolved,
    async actorThreads(documentId: string) {
      const listed = await review.listItems({ workId });
      const item = listed.items.find((candidate) => candidate.documentId === documentId);
      return (item?.actorThreadIds ?? []).map((threadId) => ({
        threadId,
        title: listed.threadTitles.get(threadId) ?? null,
      }));
    },
    async list() {
      return (await review.items({ workId })).items;
    },
    async discardItem(documentId: string) {
      const { item, branchId } = await resolved(documentId);
      return body(
        await review.discardItem({
          workId,
          item,
          userId,
          envelope: testEnvelope({ workId, kind: "discard_items", branchId, userId }),
        }),
      );
    },
    /** Discard all of the Work's active branch. */
    async discardAll() {
      const { branchId } = await review.items({ workId });
      if (!branchId) throw new Error("No active branch");
      return body(
        await review.discardAll({
          workId,
          branchId,
          userId,
          envelope: testEnvelope({ workId, kind: "discard_branch", branchId, userId }),
        }),
      );
    },
  };
  return driver;
}
