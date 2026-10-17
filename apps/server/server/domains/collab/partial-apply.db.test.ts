/** PostgreSQL proof for dependency-closed partial Apply settlement. */

import { randomUUID } from "node:crypto";
import { toDocHandle } from "@meridian/agent-edit/integration";
import { branchRoomName } from "@meridian/contracts/protocol";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runOutsideDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { testFileGrant } from "../../test-support/file-grants.js";
import { observeReviewSnapshot } from "../../test-support/review-cut-boundaries.js";
import { writeMarkdown } from "./test-support/bound-writes.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetSettlementFixture,
  schema,
  USER_ID,
} from "./test-support/branch-push-settlement-fixture.js";
import { appendBranchRows, branchContent } from "./test-support/branch-store-seam.js";
import { commitJournaledUpdate } from "./test-support/branch-update-writes.js";
import {
  BETA_ID,
  PROJECT_ID,
  THREAD_ID,
  TURN_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import {
  commitBranchEdit,
  fencedRequest,
  reviewDriver,
} from "./test-support/draft-review-requests.js";

const db = createTestDatabase();
beforeEach(() => resetSettlementFixture(db));
afterAll(() => closeDatabase(db));
let warmHarness: ReturnType<typeof createHarness> | undefined;
afterEach(() => {
  warmHarness?.destroyWarmState();
  warmHarness = undefined;
});
async function setup(
  markdown: string,
  seed: string,
  options?: Parameters<typeof createHarness>[1],
) {
  const harness = createHarness(db, options);
  warmHarness = harness;
  await harness.seedWriterDocument(markdown, seed);
  const fixture = harness.crossWorkProbeFixture();
  const branch = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
  const command = { documentId: ALPHA_ID };
  const review = reviewDriver(fixture.collab.draftReview);
  return { harness, fixture, branch, command, review };
}

describe("per-change Apply (postgres)", () => {
  it("whole Discard recovers only the addressed corrupt draft, including a rowless branch", async () => {
    const { fixture, branch, command, review } = await setup("Alpha live.", "corrupt-recovery");
    await stageText(fixture, branch.branchId, 0, " Proposal", "agent");
    await writeMarkdown(fixture.collab, {
      documentId: BETA_ID,
      markdown: "Healthy live.",
      origin: { type: "user", actorUserId: USER_ID },
      threadId: THREAD_ID,
    });
    const { draftId } = await review.resolved(ALPHA_ID);
    const healthy = await fixture.liveCoordinator.withDocument(BETA_ID, (liveDoc) =>
      fixture.branchStore.ensureDraftBranch({ documentId: BETA_ID, draftId, liveDoc }),
    );
    await stageText(fixture, healthy.branchId, 0, " Healthy proposal", "agent");
    const healthyBefore = await review.preview(BETA_ID);
    for (const rowless of [false, true]) {
      await db
        .update(schema.documentBranches)
        .set({ state: Buffer.from([255]) })
        .where(eq(schema.documentBranches.id, branch.branchId));
      expect(await review.preview(command.documentId)).toMatchObject({
        status: "corrupt",
        draftId: expect.any(String),
      });
      expect(await review.discardItem(command.documentId)).toMatchObject({
        status: "discarded",
      });
      expect(await review.preview(command.documentId)).toMatchObject({
        status: "active",
        operations: [],
      });
      expect(await fixture.draftMarkdown(branch.branchId)).toBe("Alpha live.\n");
      expect(await review.preview(BETA_ID)).toEqual(healthyBefore);
      if (!rowless)
        expect((await review.list()).map((item) => item.documentId)).not.toContain(ALPHA_ID);
    }
  });

  it("lists writing chats by their latest pending row, excluding writer and threadless rows", async () => {
    const { fixture, branch, review } = await setup(
      "Alpha base.\n\nBeta base.\n\nGamma base.",
      "writing-chats",
    );
    const otherThreadId = await seedOtherChat();
    await stageText(fixture, branch.branchId, 0, " First", "agent");
    await stageText(fixture, branch.branchId, 1, " Second", "agent", { threadId: otherThreadId });
    const latestId = await stageText(fixture, branch.branchId, 0, " Latest", "agent");
    await db
      .update(schema.branchWriteJournal)
      .set({ status: "rollback_pending" })
      .where(eq(schema.branchWriteJournal.id, latestId));
    await stageText(fixture, branch.branchId, 2, " Writer", "writer", { threadId: otherThreadId });
    await stageText(fixture, branch.branchId, 2, " Unattributed", "agent", { threadId: null });
    expect(await review.list()).toHaveLength(1);
    expect(await review.actorThreads(ALPHA_ID)).toEqual([
      { threadId: THREAD_ID, title: "Thread" },
      { threadId: otherThreadId, title: "Other chat" },
    ]);
  });

  it.each([
    "apply",
    "discard",
  ] as const)("per-change %s removes only the settled chat from the draft list", async (action) => {
    const { fixture, branch, command, review } = await setup(
      "Alpha base.\n\nBeta base.\n\nGamma base.",
      "settled-chat",
    );
    const otherThreadId = await seedOtherChat();
    const firstId = await stageText(fixture, branch.branchId, 0, " First", "agent");
    await stageText(fixture, branch.branchId, 1, " Second", "agent", { threadId: otherThreadId });
    await stageText(fixture, branch.branchId, 2, " Writer", "writer");
    expect(await review.actorThreads(ALPHA_ID)).toEqual([
      { threadId: otherThreadId, title: "Other chat" },
      { threadId: THREAD_ID, title: "Thread" },
    ]);
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing preview");
    const first = preview.operations.find((op) => op.sourceUpdateIds.includes(firstId as never));
    if (!first) throw new Error("missing first operation");
    const request = fencedRequest(command, preview, [first.operationId]);
    const result =
      action === "apply"
        ? await review.applyRequest(request)
        : await review.discardRequest(request);
    expect(result).toMatchObject({
      status: action === "apply" ? "applied" : "discarded",
      itemClosed: false,
    });
    expect(await review.list()).toHaveLength(1);
    expect(await review.actorThreads(ALPHA_ID)).toEqual([
      { threadId: otherThreadId, title: "Other chat" },
    ]);
    if (action === "apply") {
      const remaining = await review.preview(command.documentId);
      if (remaining.status !== "active") throw new Error("missing remaining preview");
      const closed = await review.discardRequest(
        fencedRequest(
          command,
          remaining,
          remaining.operations.map((op) => op.operationId),
        ),
      );
      expect(closed).toMatchObject({ itemClosed: true, itemDisposition: "applied" });
    }
  });

  it("includes cumulative earlier deletions in the class before applying a later insertion", async () => {
    const { harness, fixture, branch, command, review } = await setup(
      "Elder Mo raised his hand.\n\nSu Yin said nothing. It was a very tense moment for everyone present.\n\nThe courtyard fell silent.",
      "cumulative-delete-class",
    );
    const staged = await fixture.branchCoordinator.readBranch(
      branch.branchId,
      async (doc, snapshot) => {
        const clone = createCollabYDoc({ gc: false });
        Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
        return { clone, generation: snapshot.generation };
      },
    );
    try {
      for (const [blockIndex, find, replacement] of [
        [0, "his", ""],
        [1, " It was a very tense moment for everyone present.", ""],
        [2, "fell silent.", "fell silent. Lin Feng felt the qi coil."],
      ] as const) {
        const beforeVector = Y.encodeStateVector(staged.clone);
        const block = fixture.model.getBlocks(toDocHandle(staged.clone))[blockIndex];
        const from = fixture.model.getText(block).indexOf(find);
        fixture.model.applyTextEdit(
          toDocHandle(staged.clone),
          block,
          { from, to: from + find.length },
          replacement,
        );
        // Retained/other-producer cumulative rows must still close together.
        await commitJournaledUpdate(fixture.branchCoordinator, {
          branchId: branch.branchId,
          updateData: Y.encodeStateAsUpdate(staged.clone, beforeVector),
          source: "agent",
          actorUserId: null,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          wId: null,
          updateMeta: null,
        });
      }
    } finally {
      staged.clone.destroy();
    }
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing preview");
    expect(preview.operations).toHaveLength(3);
    expect(new Set(preview.operations.map((op) => op.closureClassId)).size).toBe(1);
    const expectedDraft =
      "Elder Mo raised  hand.\n\nSu Yin said nothing.\n\nThe courtyard fell silent. Lin Feng felt the qi coil.\n";
    expect(await fixture.draftMarkdown(branch.branchId)).toBe(expectedDraft);
    const later = preview.operations.at(-1);
    if (!later) throw new Error("missing later operation");
    const refused = await review.applyRequest(fencedRequest(command, preview, [later.operationId]));
    expect(refused).toMatchObject({ status: "incomplete_class" });
    const result = await review.applyRequest(
      fencedRequest(
        command,
        preview,
        preview.operations.map((op) => op.operationId),
      ),
    );
    expect(result).toMatchObject({ status: "applied", itemClosed: true });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(expectedDraft);
    expect(await review.list()).toEqual([]);
  });

  it("attributes agent operations to the chat's current title and the tool call that wrote them, not writer operations", async () => {
    const { fixture, branch, command, review } = await setup(
      "Alpha base.\n\nBeta base.",
      "chat-attribution",
    );
    await stageText(fixture, branch.branchId, 0, " Agent", "agent", { toolCallId: "call_write_7" });
    await stageText(fixture, branch.branchId, 1, " Writer", "writer");
    await db
      .update(schema.threads)
      .set({ title: "Renamed chat" })
      .where(eq(schema.threads.id, THREAD_ID));
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing preview");
    expect(preview.operations.find((op) => op.kind === "agent")).toMatchObject({
      actorThreadId: THREAD_ID,
      actorThreadTitle: "Renamed chat",
      actorTurnId: TURN_ID,
      actorToolCallId: "call_write_7",
    });
    const writer = preview.operations.find((op) => op.kind === "writer");
    expect(writer).toBeDefined();
    expect(writer).not.toHaveProperty("actorThreadId");
    expect(writer).not.toHaveProperty("actorThreadTitle");
    expect(writer).not.toHaveProperty("actorToolCallId");
  });

  it.each([
    "apply",
    "discard",
  ] as const)("last per-change %s closes, disappears from the Work list, and later AI writes reopen", async (action) => {
    const { harness, fixture, branch, command, review } = await setup("Alpha base.", "last-change");
    await stageText(fixture, branch.branchId, 0, " Proposed", "agent");
    const duplicate = await fixture.branchCoordinator.readBranch(branch.branchId, async (doc) =>
      Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc)),
    );
    await appendBranchRows(fixture.branchStore, branch.branchId, [
      { source: "writer", actorUserId: USER_ID, updateData: duplicate },
    ]);
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing preview");
    const request = fencedRequest(
      command,
      preview,
      preview.operations.map((op) => op.operationId),
    );
    const result =
      action === "apply"
        ? await review.applyRequest(request)
        : await review.discardRequest(request);
    expect(await review.list()).toEqual([]);
    expect(result).toMatchObject({
      itemClosed: true,
      itemDisposition: action === "apply" ? "applied" : "discarded",
    });
    expect((await fixture.branchStore.getBranch(branch.branchId))?.generation).toBe(
      branch.generation + 1,
    );
    expect(preview.branchGeneration).toBe(branch.generation);
    // The close's reset keeps the id: the same draft, one generation up, nothing to review.
    const reset = await review.preview(command.documentId);
    expect(reset).toMatchObject({
      status: "active",
      branchGeneration: branch.generation + 1,
      reviewRoomName: branchRoomName(branch.branchId, branch.generation + 1),
      operations: [],
      hunks: [],
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(
      action === "apply" ? "Alpha base. Proposed\n" : "Alpha base.\n",
    );
    await stageText(fixture, branch.branchId, 0, " New proposal", "agent");
    // The next proposal shares the reset's generation and room; its changes tell them apart.
    const rows = await review.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      branchGeneration: branch.generation + 1,
    });
    const next = await review.preview(command.documentId);
    if (next.status !== "active") throw new Error("missing preview");
    expect(next.branchGeneration).toBe(branch.generation + 1);
    expect(next.reviewRoomName).toBe(reset.status === "active" ? reset.reviewRoomName : "");
    expect(next.operations).not.toHaveLength(0);
  });

  it.each([
    "writer",
    "agent",
  ] as const)("a %s live write preserves a pending draft's changes and identity", async (source) => {
    const { harness, fixture, branch, command, review } = await setup(
      "Alpha base.\n\nBeta base.",
      "live-write-investigation",
    );
    const pendingId = await stageText(fixture, branch.branchId, 0, " Pending proposal", "agent");
    if (source === "writer") {
      await writeMarkdown(fixture.collab, {
        documentId: ALPHA_ID,
        markdown: "Alpha rewritten. Live writer.\n\nBeta base.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD_ID,
      });
    } else {
      const responseId = randomUUID();
      await db.insert(schema.modelResponses).values({
        id: responseId as never,
        turnId: TURN_ID,
        sequence: 1,
        provider: "fixture",
        model: "fixture",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      const context = {
        sessionId: THREAD_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
        grant: testFileGrant({ kind: "live" }),
      };
      await fixture.collab.agentEdit().read({ file: "alpha.md", documentId: ALPHA_ID }, context);
      await expect(
        fixture.collab.agentEdit().write(
          {
            command: "replace",
            file: "alpha.md",
            documentId: ALPHA_ID,
            find: "Alpha base.",
            content: "Alpha rewritten. Live agent.",
          },
          context,
        ),
      ).resolves.toMatchObject({ status: "success", phase: "staged" });
      await expect(
        fixture.collab.finalizeResponseCommit(
          { providerResponseId: responseId, editScopeId: responseId },
          { threadId: THREAD_ID, turnId: TURN_ID },
        ),
      ).resolves.toMatchObject({ status: "committed" });
    }
    await fixture.branchPulls.flushLivePull(ALPHA_ID);
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing pending preview");
    expect(await fixture.draftMarkdown(branch.branchId)).toContain("Pending proposal");
    expect(await fixture.draftMarkdown(branch.branchId)).toContain(
      source === "writer" ? "Live writer" : "Live agent",
    );
    expect(await harness.liveMarkdown(ALPHA_ID)).not.toContain("Pending proposal");
    expect(preview.operations.flatMap((op) => op.sourceUpdateIds)).toContain(pendingId);
    expect(await journalStatuses(branch.branchId)).toContainEqual({
      id: pendingId,
      status: "active",
    });
    expect(await review.list()).toHaveLength(1);
    expect((await fixture.branchStore.getBranch(branch.branchId))?.generation).toBe(
      branch.generation,
    );
    await review.applyItem(command.documentId);
    expect(await harness.liveMarkdown(ALPHA_ID)).toContain("Pending proposal");
    expect(await harness.liveMarkdown(ALPHA_ID)).toContain(
      source === "writer" ? "Live writer" : "Live agent",
    );
  });

  it("publishes one closed group, removes it from review, then whole Apply publishes the rest once", async () => {
    const { harness, fixture, branch, command, review } = await setup(
      "Alpha base.\n\nBeta base.",
      "partial-apply-poc",
    );

    const firstId = await stageText(fixture, branch.branchId, 0, " Agent-one", "agent");
    const secondId = await stageText(fixture, branch.branchId, 1, " Writer-two", "writer");

    const before = await review.preview(command.documentId);
    if (before.status !== "active") throw new Error("missing preview");
    const first = before.operations.find((op) => op.sourceUpdateIds.includes(firstId as never));
    if (!first) throw new Error("missing selected operation");
    await expect(
      review.applyRequest(fencedRequest(command, before, [first.operationId])),
    ).resolves.toMatchObject({
      status: "applied",
      operationIds: [first.operationId],
      closureClassIds: [first.closureClassId],
    });

    const afterPartial = await harness.liveMarkdown(ALPHA_ID);
    expect(afterPartial).toBe("Alpha base. Agent-one\n\nBeta base.\n");

    const preview = await review.preview(command.documentId);
    expect(preview.status).toBe("active");
    if (preview.status !== "active") throw new Error("draft unexpectedly settled");
    expect(preview.operations.flatMap((operation) => operation.sourceUpdateIds)).toEqual([
      secondId,
    ]);

    await expect(review.applyItem(command.documentId)).resolves.toMatchObject({
      status: "applied",
    });

    const live = await harness.liveMarkdown(ALPHA_ID);
    expect(occurrences(live, "Agent-one")).toBe(1);
    expect(occurrences(live, "Writer-two")).toBe(1);
    expect(await journalStatuses(branch.branchId)).toEqual([
      { id: firstId, status: "pushed" },
      { id: secondId, status: "pushed" },
    ]);
    const attributed = await db
      .select({
        originType: schema.documentYjsUpdates.originType,
        actorUserId: schema.documentYjsUpdates.actorUserId,
        actorTurnId: schema.documentYjsUpdates.actorTurnId,
      })
      .from(schema.documentYjsUpdates)
      .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID));
    expect(attributed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ originType: "agent", actorTurnId: TURN_ID }),
        expect.objectContaining({ originType: "human", actorUserId: USER_ID }),
      ]),
    );
  });

  it.each([
    "live",
    "draft",
    "same-paragraph-agent",
    "gone",
    "archived",
  ] as const)("refuses %s without publishing", async (kind) => {
    const { harness, fixture, branch, command, review } = await setup(
      "Alpha base.\n\nBeta base.",
      "refusal",
    );
    await stageText(fixture, branch.branchId, 0, " Proposed", "agent");
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing preview");
    if (kind === "draft") await stageText(fixture, branch.branchId, 1, " Later", "writer");
    if (kind === "same-paragraph-agent")
      await stageText(fixture, branch.branchId, 0, " Another write", "agent");
    if (kind === "live")
      await harness.seedWriterDocument("Changed live.\n\nBeta base.", "live-change");
    if (kind === "archived")
      await db
        .update(schema.works)
        .set({ archivedAt: new Date() })
        .where(eq(schema.works.id, WORK_ID));
    const request = fencedRequest(
      command,
      preview,
      preview.operations.map((op) => op.operationId),
    );
    if (kind === "gone") {
      await review.discardRequest(request);
      await expect(review.applyRequest(request)).resolves.toMatchObject({ status: "stale" });
      const current = await review.preview(command.documentId);
      if (current.status !== "active") throw new Error("missing current preview");
      request.preview = current;
    }
    if (kind === "archived")
      await expect(review.applyRequest(request)).rejects.toMatchObject({
        name: "WorkLifecycleUnavailableError",
        state: "archived",
        workId: WORK_ID,
      });
    else
      await expect(review.applyRequest(request)).resolves.toMatchObject({
        status: kind === "gone" ? "gone" : "stale",
      });
    expect(await harness.liveMarkdown(ALPHA_ID)).not.toContain("Proposed");
  });

  it("applies a mixed agent/writer class with both authors, rejecting an incomplete class", async () => {
    const { harness, fixture, branch, command, review } = await setup("Alpha base.", "mixed-class");
    await stageText(fixture, branch.branchId, 0, " Agent", "agent");
    await stageText(fixture, branch.branchId, 0, " Writer", "writer");
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing preview");
    expect(preview.operations).toHaveLength(2);
    expect(new Set(preview.operations.map((op) => op.closureClassId)).size).toBe(1);
    const request = fencedRequest(
      command,
      preview,
      preview.operations.map((op) => op.operationId),
    );
    await expect(
      review.applyRequest({
        ...request,
        operationIds: request.operationIds.slice(0, 1),
      }),
    ).resolves.toMatchObject({ status: "incomplete_class" });
    await expect(review.applyRequest(request)).resolves.toMatchObject({
      status: "applied",
      operationIds: request.operationIds,
      closureClassIds: [preview.operations[0].closureClassId],
      itemClosed: true,
      itemDisposition: "applied",
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha base. Agent Writer\n");
    const authors = await db
      .select({
        origin: schema.documentYjsUpdates.originType,
        turn: schema.documentYjsUpdates.actorTurnId,
        user: schema.documentYjsUpdates.actorUserId,
      })
      .from(schema.documentYjsUpdates)
      .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID));
    expect(authors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: "agent", turn: TURN_ID }),
        expect.objectContaining({ origin: "human", user: USER_ID }),
      ]),
    );
  });

  it("Discard of one operation removes the entire mixed dependency class", async () => {
    const { harness, fixture, branch, command, review } = await setup(
      "Alpha base.",
      "mixed-discard",
    );
    await stageText(fixture, branch.branchId, 0, " Agent", "agent");
    await stageText(fixture, branch.branchId, 0, " Writer", "writer");
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing preview");
    await review.discardRequest(
      fencedRequest(command, preview, [preview.operations[0].operationId]),
    );
    const after = await review.preview(command.documentId);
    if (after.status !== "active") throw new Error("missing preview");
    expect(await fixture.draftMarkdown(branch.branchId)).toBe("Alpha base.\n");
    expect(after.operations).toEqual([]);
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha base.\n");
  });

  it.each([
    "apply",
    "discard",
  ] as const)("rejects a live admission after %s selection at the durable commit fence without settling rows", async (action) => {
    const { harness, fixture, branch, command, review } = await setup(
      "Alpha base.",
      "commit-fence",
    );
    const selectedId = await stageText(fixture, branch.branchId, 0, " Proposed", "agent");
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing preview");
    const bumpLive = async () => {
      await fixture.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
        const before = Y.encodeStateVector(doc);
        const block = fixture.model.getBlocks(toDocHandle(doc))[0];
        fixture.model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, "New live. ");
        await fixture.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
          origin: `human:${USER_ID}`,
          seq: 0,
        });
      });
    };
    const select = async () => {
      await bumpLive();
      return { journalIds: [selectedId], expectedLiveRevision: preview.liveRevisionToken };
    };
    await expect(
      action === "apply"
        ? fixture.realBranchPush.pushBranchesToLive({
            branchIds: [branch.branchId],
            pushedByUserId: USER_ID,
            selected: {
              branchId: branch.branchId,
              select: async () => ({ ...(await select()), payloads: {} }),
            },
          })
        : fixture.branchReview.discardSelected({
            branchId: branch.branchId,
            selectRows: select,
            reviewedByUserId: USER_ID,
          }),
    ).rejects.toMatchObject({ status: "stale" });
    expect(await journalStatuses(branch.branchId)).toEqual([{ id: selectedId, status: "active" }]);
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("New live. Alpha base.\n");
  });

  it("Discard closes independent visible hunks sharing a Yjs client clock prefix", async () => {
    const { fixture, branch, command, review } = await setup(
      "Alpha base.\n\nBeta base.",
      "clock-discard",
    );
    const first = await stageText(fixture, branch.branchId, 0, " Agent", "agent");
    const [row] = await db
      .select()
      .from(schema.branchWriteJournal)
      .where(eq(schema.branchWriteJournal.id, first));
    const clientId = Y.decodeUpdate(row.updateData).structs[0].id.client;
    await stageText(fixture, branch.branchId, 1, " Writer", "writer", { clientId });
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("missing preview");
    expect(preview.hunks).toHaveLength(2);
    expect(new Set(preview.operations.map((op) => op.closureClassId)).size).toBe(1);
    await review.discardRequest(
      fencedRequest(command, preview, [preview.operations[0].operationId]),
    );
    const after = await review.preview(command.documentId);
    if (after.status !== "active") throw new Error("missing preview");
    expect(await fixture.draftMarkdown(branch.branchId)).toBe("Alpha base.\n\nBeta base.\n");
    expect(after.operations).toEqual([]);
  });

  it("selective and whole-draft Discard never revert a partially applied group on live", async () => {
    const { harness, fixture, branch, command, review } = await setup(
      "Alpha base.\n\nBeta base.",
      "partial-discard-poc",
    );
    const appliedId = await stageText(fixture, branch.branchId, 0, " Applied", "agent");
    const discardedId = await stageText(fixture, branch.branchId, 1, " Discard-me", "agent");

    const beforeApply = await review.preview(command.documentId);
    if (beforeApply.status !== "active") throw new Error("missing preview");
    const applied = beforeApply.operations.find((op) =>
      op.sourceUpdateIds.includes(appliedId as never),
    );
    if (!applied) throw new Error("applied operation is unavailable");
    await review.applyRequest(fencedRequest(command, beforeApply, [applied.operationId]));
    const preview = await review.preview(command.documentId);
    if (preview.status !== "active") throw new Error("draft unexpectedly settled");
    const remaining = preview.operations.find((operation) =>
      operation.sourceUpdateIds.includes(discardedId as never),
    );
    if (!remaining) throw new Error("remaining review operation is unavailable");
    await review.discardRequest(fencedRequest(command, preview, [remaining.operationId]));
    let live = await harness.liveMarkdown(ALPHA_ID);
    expect(live).toContain("Applied");
    expect(live).not.toContain("Discard-me");

    await stageText(fixture, branch.branchId, 1, " Whole-discard", "agent");
    await review.discardItem(command.documentId);
    live = await harness.liveMarkdown(ALPHA_ID);
    expect(live).toContain("Applied");
    expect(live).not.toContain("Discard-me");
    expect(live).not.toContain("Whole-discard");
  });
});

type Fixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;

describe("ReviewCut concurrent capture (postgres)", () => {
  it.each([
    ["preview", "append"],
    ["preview", "refork"],
    ["preview", "status"],
    ["apply", "append"],
    ["apply", "refork"],
    ["apply", "status"],
    ["discard", "append"],
    ["discard", "refork"],
    ["discard", "status"],
  ] as const)("%s stays coherent or refuses %s at every read await", async (action, mutation) => {
    let enabled = false;
    let target = -1;
    let seen = 0;
    let inject = async () => {};
    const boundary = async () => {
      if (!enabled) return;
      const index = seen++;
      if (index === target) await runOutsideDrizzleTransaction(inject);
    };
    const snapshotDb = observeReviewSnapshot(db, boundary);
    const harness = createHarness(snapshotDb, {
      reviewCut: (read) => async (address) => {
        await boundary();
        const cut = await read(address);
        await boundary();
        return cut;
      },
    });
    warmHarness = harness;
    await harness.seedWriterDocument("Alpha base.\n\nBeta base.", "review-cut-boundary");
    const fixture = harness.crossWorkProbeFixture();
    const branch = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    const command = { documentId: ALPHA_ID };
    const review = reviewDriver(fixture.collab.draftReview);
    const firstId = await stageText(fixture, branch.branchId, 0, " Proposed", "agent");
    const before = await review.preview(command.documentId);
    if (before.status !== "active") throw new Error("missing preview");
    const [original] = await db
      .select()
      .from(schema.documentBranches)
      .where(eq(schema.documentBranches.id, branch.branchId));
    const proposed = createCollabYDoc({ gc: false });
    Y.applyUpdate(proposed, await branchContent(db, original.id));
    const vector = Y.encodeStateVector(proposed);
    const beta = fixture.model.getBlocks(toDocHandle(proposed))[1];
    fixture.model.applyTextEdit(toDocHandle(proposed), beta, { from: 10, to: 10 }, " Concurrent");
    const appended = Y.encodeStateAsUpdate(proposed, vector);
    proposed.destroy();
    // A checkpoint rewrite: a new revision the checkpoint was written at, covering every row.
    const rewrittenCheckpoint = {
      revision: sql`${schema.documentBranches.revision} + 1`,
      checkpointRevision: sql`${schema.documentBranches.revision} + 1`,
      checkpointSeq: sql`(select coalesce(max(id), 0) from branch_write_journal where branch_id = ${branch.branchId})`,
    };
    inject = async () => {
      await db.transaction(async (tx) => {
        if (mutation === "append") {
          await tx.insert(schema.branchWriteJournal).values({
            branchId: branch.branchId,
            generation: original.generation,
            source: "writer",
            actorUserId: USER_ID,
            updateData: Buffer.from(appended),
            draftBaseUpdateSeq: 0,
          });
          // An append: a tail row, and the revision every committed write moves.
          await tx
            .update(schema.documentBranches)
            .set({ revision: sql`${schema.documentBranches.revision} + 1` })
            .where(eq(schema.documentBranches.id, branch.branchId));
        } else if (mutation === "refork") {
          await tx
            .update(schema.documentBranches)
            .set({
              generation: original.generation + 1,
              state: original.liveCut ?? original.state,
              ...rewrittenCheckpoint,
            })
            .where(eq(schema.documentBranches.id, branch.branchId));
        } else {
          await tx
            .update(schema.documentBranches)
            .set({ revision: sql`${schema.documentBranches.revision} + 1` })
            .where(eq(schema.documentBranches.id, branch.branchId));
          await tx
            .update(schema.branchWriteJournal)
            .set({ status: "pushed" })
            .where(eq(schema.branchWriteJournal.id, firstId));
        }
      });
    };
    async function restore() {
      // A successful selective Discard re-journals survivors in its successor
      // generation. Restore this boundary's original fixture, not those aliases.
      await db
        .delete(schema.branchWriteJournal)
        .where(
          and(
            eq(schema.branchWriteJournal.branchId, branch.branchId),
            ne(schema.branchWriteJournal.id, firstId),
          ),
        );
      await db
        .update(schema.branchWriteJournal)
        .set({ status: "active" })
        .where(eq(schema.branchWriteJournal.id, firstId));
      await db
        .update(schema.documentBranches)
        .set({
          state: original.state,
          stateVector: original.stateVector,
          generation: original.generation,
          ...rewrittenCheckpoint,
          checkpointSeq: original.checkpointSeq,
        })
        .where(eq(schema.documentBranches.id, branch.branchId));
    }
    // Enumerate actual query awaits, plus entry/return of the read port. No
    // sleeps or guesses about scheduler timing; each mutation commits elsewhere.
    enabled = true;
    await review.preview(command.documentId);
    enabled = false;
    const boundaryCount = seen;
    console.info(`ReviewCut ${action}/${mutation}: ${boundaryCount} read await boundaries`);
    expect(boundaryCount).toBeGreaterThan(8);
    for (target = 0; target < boundaryCount; target++) {
      seen = 0;
      enabled = true;
      if (action === "preview") {
        const result = await review.preview(command.documentId);
        enabled = false;
        const after = await review.preview(command.documentId);
        expect([before, after]).toContainEqual(result);
      } else {
        const request = fencedRequest(
          command,
          before,
          before.operations.map((op) => op.operationId),
        );
        const result =
          action === "apply"
            ? await review.applyRequest(request)
            : await review.discardRequest(request);
        enabled = false;
        expect(result).toMatchObject({
          status: action === "discard" ? (mutation === "append" ? "discarded" : "gone") : "stale",
        });
        if (action === "discard" && mutation === "append") {
          expect(await fixture.draftMarkdown(branch.branchId)).toBe(
            "Alpha base.\n\nBeta base. Concurrent\n",
          );
        }
      }
      enabled = false;
      expect(seen).toBeGreaterThan(target);
      await restore();
    }
  });
});

async function stageText(
  fixture: Fixture,
  branchId: string,
  blockIndex: number,
  suffix: string,
  source: "agent" | "writer",
  options: { clientId?: number; toolCallId?: string; threadId?: typeof THREAD_ID | null } = {},
): Promise<number> {
  await commitBranchEdit(fixture, branchId, { source, ...options }, (doc) => {
    const block = fixture.model.getBlocks(toDocHandle(doc))[blockIndex];
    if (!block) throw new Error(`missing block ${blockIndex}`);
    const end = fixture.model.getText(block).length;
    fixture.model.applyTextEdit(toDocHandle(doc), block, { from: end, to: end }, suffix);
  });
  const rows = await db
    .select({ id: schema.branchWriteJournal.id })
    .from(schema.branchWriteJournal)
    .where(eq(schema.branchWriteJournal.branchId, branchId))
    .orderBy(asc(schema.branchWriteJournal.id));
  const id = rows.at(-1)?.id;
  if (!id) throw new Error("staged journal row is unavailable");
  return id;
}

async function journalStatuses(branchId: string) {
  return db
    .select({ id: schema.branchWriteJournal.id, status: schema.branchWriteJournal.status })
    .from(schema.branchWriteJournal)
    .where(eq(schema.branchWriteJournal.branchId, branchId))
    .orderBy(asc(schema.branchWriteJournal.id));
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}

async function seedOtherChat() {
  const threadId = randomUUID() as typeof THREAD_ID;
  await db.insert(schema.threads).values({
    id: threadId,
    rootThreadId: threadId,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title: "Other chat",
    kind: "primary",
    status: "idle",
  });
  return threadId;
}
