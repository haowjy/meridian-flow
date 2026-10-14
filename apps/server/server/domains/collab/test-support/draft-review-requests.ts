/** Snapshot-owned branch mutations and the writer's review commands, as a facade-level driver. */
import { randomUUID } from "node:crypto";
import {
  applySpanPatches,
  composeGroups,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { DraftCommandId, DraftId, UserId, WorkId } from "@meridian/contracts";
import type { DraftCommandKind } from "@meridian/contracts/drafts";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DraftReviewApi } from "../contracts.js";
import { commandDigest, type DraftCommandEnvelope } from "../domain/draft-commands.js";
import { commitSegmentRows } from "./branch-update-writes.js";
import {
  type createHarness,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
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
    await commitSegmentRows(fixture.branchCoordinator, {
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

/** A fresh command envelope for facade-level suites; the route builds its own from the body. */
export function testEnvelope(input: {
  workId: WorkId;
  kind: DraftCommandKind;
  draftId: DraftId | null;
  userId?: UserId;
  commandId?: DraftCommandId;
  body?: unknown;
}): DraftCommandEnvelope {
  const accountId = input.userId ?? (USER_ID as UserId);
  return {
    commandId: input.commandId ?? (randomUUID() as DraftCommandId),
    workId: input.workId,
    accountId,
    kind: input.kind,
    draftId: input.draftId,
    digest: commandDigest({
      accountId,
      projectId: "",
      workId: input.workId,
      kind: input.kind,
      selectors: { draftId: input.draftId },
      body: input.body ?? null,
    }),
  };
}

/**
 * What the writer's review room shows for an item right now: its change groups (the ids a
 * `changes` Apply names) and the `snapshot` of the room those ids belong to.
 */
export async function reviewFrame(fixture: Fixture, documentId: string) {
  const { item } = await reviewDriver(fixture.collab.draftReview).resolved(documentId);
  if (!item.draftBranchId) throw new Error(`${documentId} has no text branch`);
  return fixture.branchCoordinator.readBranch(item.draftBranchId, async (doc) => {
    const schema = buildDocumentSchema();
    const base = readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema);
    const draft = readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
    return {
      snapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString("base64"),
      groups: projectReview(diffBlocks(base, draft)).groups,
    };
  });
}

/**
 * The writer discards a change in the room: the draft returns to the base for the change
 * containing `excerpt` (what the client does locally; the server sees an ordinary writer edit).
 */
export async function discardChangeLocally(fixture: Fixture, documentId: string, excerpt: string) {
  const { item } = await reviewDriver(fixture.collab.draftReview).resolved(documentId);
  if (!item.draftBranchId) throw new Error(`${documentId} has no text branch`);
  const schema = buildDocumentSchema();
  await commitBranchEdit(
    fixture,
    item.draftBranchId,
    { source: "writer", threadId: null },
    (doc) => {
      const base = readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema);
      const draft = readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
      const projection = projectReview(diffBlocks(base, draft));
      const group = projection.groups.find((candidate) =>
        candidate.excerpt.inserted.includes(excerpt),
      );
      if (!group) throw new Error(`No change inserts ${excerpt}`);
      const next = applySpanPatches(
        draft,
        composeGroups(schema, projection, [group.id], "discard"),
        "draft",
      );
      doc.transact(() => writeBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, next));
    },
  );
}

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
    async meta(documentId: string) {
      return review.itemMeta({ workId, itemKey: (await resolved(documentId)).itemKey });
    },
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
    async applyItem(documentId: string) {
      const { item, draftId } = await resolved(documentId);
      return body(
        await review.applyItem({
          workId,
          item,
          userId,
          envelope: testEnvelope({ workId, kind: "apply_items", draftId, userId }),
        }),
      );
    },
    async discardItem(documentId: string) {
      const { item, draftId } = await resolved(documentId);
      return body(
        await review.discardItem({
          workId,
          item,
          userId,
          envelope: testEnvelope({ workId, kind: "discard_items", draftId, userId }),
        }),
      );
    },
    /** Apply the named changes of one item, as projected in `snapshot`'s frame. */
    async applyChanges(documentId: string, changeIds: string[], snapshot: string) {
      const { item, draftId } = await resolved(documentId);
      return body(
        await review.applyChanges({
          workId,
          item,
          userId,
          envelope: testEnvelope({ workId, kind: "apply_changes", draftId, userId }),
          changeIds,
          snapshot,
        }),
      );
    },
    /** Discard all of the Work's active draft. */
    async discardAll() {
      const { draftId } = await review.items({ workId });
      if (!draftId) throw new Error("No active draft");
      return body(
        await review.discardAll({
          workId,
          draftId,
          userId,
          envelope: testEnvelope({ workId, kind: "discard_draft", draftId, userId }),
        }),
      );
    },
    /** Apply every listed item of the Work's active draft. */
    async applyAll() {
      const { draftId, items } = await review.items({ workId });
      if (!draftId) throw new Error("No active draft");
      return body(
        await review.applyAll({
          workId,
          draftId,
          items: items.map((item) => ({
            itemKey: item.itemKey,
            locationToken: item.tokens.locationToken,
          })),
          userId,
          envelope: testEnvelope({ workId, kind: "apply_items", draftId, userId }),
        }),
      );
    },
  };
  return driver;
}
