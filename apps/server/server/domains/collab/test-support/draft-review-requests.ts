/** Snapshot-owned draft edits and explicit preview-fenced request envelopes. */
import { randomUUID } from "node:crypto";
import type {
  BranchId,
  CommandId,
  DraftOwner,
  ProjectId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import type { CommandKind } from "@meridian/contracts/commands";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { type CommandEnvelope, commandDigest } from "../../../shared/commands/command-record.js";
import type { DraftReviewApi } from "../contracts.js";
import {
  type createHarness,
  PROJECT_ID,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./collab-postgres-harness.js";
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
  const staged = await fixture.draftCoordinator.readDraft(draftId, async (doc, _snapshot) => {
    const clone = createCollabYDoc({ gc: false });
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    return { clone };
  });
  try {
    if (author.clientId !== undefined) staged.clone.clientID = author.clientId;
    mutate(staged.clone);
    await commitDraftRows(fixture.draftCoordinator, {
      draftId: draftId,
      sourceDoc: staged.clone,
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
  kind: CommandKind;
  branchId: BranchId;
  userId?: UserId;
  commandId?: CommandId;
  body?: unknown;
}): CommandEnvelope {
  const accountId = input.userId ?? (USER_ID as UserId);
  return {
    commandId: input.commandId ?? (randomUUID() as CommandId),
    accountId,
    projectId: PROJECT_ID as ProjectId,
    kind: input.kind,
    digest: commandDigest({
      accountId,
      projectId: PROJECT_ID,
      branchId: input.branchId,
      kind: input.kind,
      selectors: { branchId: input.branchId },
      body: input.body ?? null,
    }),
  };
}

export function reviewDriver(
  review: DraftReviewApi,
  scope: { owner?: DraftOwner; userId?: UserId } = {},
) {
  const owner = scope.owner ?? { kind: "work", workId: WORK_ID as WorkId };
  const userId = scope.userId ?? (USER_ID as UserId);
  const body = (outcome: Awaited<ReturnType<DraftReviewApi["discardItem"]>>) =>
    outcome.kind === "result" ? outcome.result : outcome;
  async function resolved(documentId: string) {
    const found = await review.resolveItemByDocument({ owner, documentId: documentId as never });
    if (!found) throw new Error(`No review item for ${documentId}`);
    return found;
  }
  const driver = {
    resolved,
    async actorThreads(documentId: string) {
      const listed = await review.listItems({ owner });
      const item = listed.items.find((candidate) => candidate.documentId === documentId);
      return (item?.actorThreadIds ?? []).map((threadId) => ({
        threadId,
        title: listed.threadTitles.get(threadId) ?? null,
      }));
    },
    async list() {
      return (await review.items({ owner })).items;
    },
    async discardItem(documentId: string) {
      const { item, branchId } = await resolved(documentId);
      return body(
        await review.discardItem({
          item,
          ends: "item",
          userId,
          envelope: testEnvelope({ kind: "discard", branchId, userId }),
        }),
      );
    },
    /** Discard all of the Work's active branch. */
    async discardAll() {
      const { branchId } = await review.items({ owner });
      if (!branchId) throw new Error("No active branch");
      return body(
        await review.discardAll({
          branchId,
          userId,
          envelope: testEnvelope({ kind: "discard", branchId, userId }),
        }),
      );
    },
  };
  return driver;
}
