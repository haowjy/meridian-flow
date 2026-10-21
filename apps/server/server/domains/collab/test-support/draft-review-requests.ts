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
import { commitDraftRows } from "./draft-update-writes.js";
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
    await commitDraftRows(fixture.draftCoordinator, {
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

/** The per-change selection a client sends after previewing, for the operations it clicked. */
export function fencedSelection(
  preview: {
    liveRevisionToken: string;
    draftRevisionToken: string;
    operations: readonly {
      operationId: string;
      partKey?: string;
      admissionToken: string;
      closureClassId: string;
    }[];
  },
  operationIds: string[],
) {
  const clicked = preview.operations.filter((op) => operationIds.includes(op.operationId));
  return {
    operationIds,
    memberPartKeys: clicked.flatMap((op) => (op.partKey ? [op.partKey] : [])),
    memberPartKeysComplete: true,
    admissionTokens: [...new Set(clicked.map((op) => op.admissionToken))],
    closureClassIds: [...new Set(clicked.map((op) => op.closureClassId))],
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
  };
}

export type ClickedChanges = {
  documentId: string;
  preview: ActivePreview;
  operationIds: string[];
};

/** What a click on `operationIds` of a previewed item sends. */
export function fencedRequest(
  command: { documentId: string },
  preview: ActivePreview,
  operationIds: string[],
): ClickedChanges {
  return { documentId: command.documentId, preview, operationIds };
}

type ActivePreview = Extract<Awaited<ReturnType<DraftReviewApi["preview"]>>, { status: "active" }>;

/**
 * The writer's review commands by document, each under a fresh command id, answering the
 * command's stored body. The facade names items by `itemKey`; suites name documents.
 */
export function reviewDriver(
  review: DraftReviewApi,
  scope: { workId?: WorkId; userId?: UserId } = {},
) {
  const workId = scope.workId ?? (WORK_ID as WorkId);
  const userId = scope.userId ?? (USER_ID as UserId);
  const body = (outcome: Awaited<ReturnType<DraftReviewApi["applyItem"]>>) =>
    outcome.kind === "result" ? outcome.result : outcome;
  async function resolved(documentId: string) {
    const found = await review.resolveItemByDocument({ workId, documentId: documentId as never });
    if (!found) throw new Error(`No review item for ${documentId}`);
    return found;
  }
  const driver = {
    resolved,
    /** The wire-less shape of a click: the document, its preview and the operations chosen. */
    applyRequest: (request: ClickedChanges) =>
      driver.applyChanges(request.documentId, request.preview, request.operationIds),
    discardRequest: (request: ClickedChanges) =>
      driver.discardChanges(request.documentId, request.preview, request.operationIds),
    async actorThreads(documentId: string) {
      const listed = await review.listItems({ workId });
      const item = listed.items.find((candidate) => candidate.documentId === documentId);
      return (item?.actorThreadIds ?? []).map((threadId) => ({
        threadId,
        title: listed.threadTitles.get(threadId) ?? null,
      }));
    },
    async preview(documentId: string) {
      return review.preview({ workId, itemKey: (await resolved(documentId)).itemKey });
    },
    async activePreview(documentId: string): Promise<ActivePreview> {
      const preview = await driver.preview(documentId);
      if (preview.status !== "active") throw new Error(`No active review of ${documentId}`);
      return preview;
    },
    async list() {
      return (await review.items({ workId })).items;
    },
    async applyItem(documentId: string) {
      const { item, branchId } = await resolved(documentId);
      return body(
        await review.applyItem({
          workId,
          item,
          userId,
          envelope: testEnvelope({ workId, kind: "apply_items", branchId, userId }),
        }),
      );
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
    async applyChanges(documentId: string, preview: ActivePreview, operationIds?: string[]) {
      const { itemKey, branchId } = await resolved(documentId);
      const ids = operationIds ?? preview.operations.map((op) => op.operationId);
      return body(
        await review.applyChanges({
          workId,
          itemKey,
          userId,
          envelope: testEnvelope({ workId, kind: "apply_changes", branchId, userId }),
          selection: { kind: "apply", ...fencedSelection(preview, ids) },
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
    /** Apply every listed item of the Work's active branch. */
    async applyAll() {
      const { branchId, items } = await review.items({ workId });
      if (!branchId) throw new Error("No active branch");
      return body(
        await review.applyAll({
          workId,
          branchId,
          items: items.map(({ itemKey }) => ({ itemKey })),
          userId,
          envelope: testEnvelope({ workId, kind: "apply_items", branchId, userId }),
        }),
      );
    },
    async discardChanges(documentId: string, preview: ActivePreview, operationIds?: string[]) {
      const { itemKey, branchId } = await resolved(documentId);
      const ids = operationIds ?? preview.operations.map((op) => op.operationId);
      return body(
        await review.discardChanges({
          workId,
          itemKey,
          userId,
          envelope: testEnvelope({ workId, kind: "discard_changes", branchId, userId }),
          selection: { kind: "discard", ...fencedSelection(preview, ids) },
        }),
      );
    },
  };
  return driver;
}
