import { toDocHandle } from "@meridian/agent-edit/integration";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { DraftReviewApi } from "./contracts.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  db,
  PROJECT_ID,
  resetDatabase,
  runInDrizzleTransaction,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

async function currentDraftId(
  draftReview: DraftReviewApi,
  input: { projectId?: ProjectId; workId: WorkId; documentId: DocumentId },
): Promise<string> {
  const drafts = await draftReview.list(input);
  const draft = drafts.find((candidate) => candidate.documentId === input.documentId);
  if (!draft) throw new Error("missing reviewable draft");
  return draft.draftId;
}

describe("change trail (postgres)", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("rolls back all ten state surfaces and commits the retained response on retry", async () => {
    const harness = createHarness();
    await harness.seedAndStage("retry-response");
    const before = await harness.captureState();
    const staged = harness.stagedUpdates("retry-response");

    harness.failSecondJournalInsert = true;
    await expect(harness.commit("retry-response")).rejects.toThrow(
      "injected second-document journal failure",
    );

    // Amendment-2 §F's ten rollback surfaces, kept explicit so a regression names its leak.
    expect(await harness.responseJournalRows()).toEqual([]); // 1. Postgres journal
    expect(await harness.databaseBranchHashes()).toEqual(before.databaseBranchHashes); // 2. snapshots
    expect(await harness.threadPeerMarkdown()).toEqual(before.threadPeerMarkdown); // 3. peer cache
    expect(await harness.workDraftMarkdown()).toEqual(before.workDraftMarkdown); // 4. draft cache
    expect(harness.stagedUpdates("retry-response").map((updates) => updates.length)).toEqual([
      1, 1,
    ]); // 5. facade still owns the response
    expect(harness.stagedUpdates("retry-response")).toEqual(staged); // 6. raw staged updates retained
    expect(harness.pendingWatermarkDocuments()).toEqual([]); // 7. pending watermarks cleared
    expect(harness.responseEvents("retry-response")).not.toContainEqual(
      expect.objectContaining({ transition: "closed" }),
    ); // 8. lifecycle not closed (retained buffers prove buffered ownership)
    expect(harness.afterCommitEffects()).toEqual({
      autoPushSchedules: [],
      branchBroadcasts: [],
      watermarkCommits: [],
    }); // 9. callbacks not dispatched
    expect(harness.openRoomIds()).toEqual([ALPHA_ID, BETA_ID]);
    expect(harness.liveRoomBroadcasts()).toEqual([]);
    // 10. No notices persisted; this scenario does not engage the producer. The
    // late-sweep ambient-rollback differential below verifies its transaction binding.
    expect(await harness.noticeRows()).toEqual([]);

    harness.failSecondJournalInsert = false;
    await expect(harness.commit("retry-response")).resolves.toMatchObject({
      status: "committed",
      documents: expect.arrayContaining([
        expect.objectContaining({ documentId: ALPHA_ID }),
        expect.objectContaining({ documentId: BETA_ID }),
      ]),
    });
    await harness.expectSuccessfulCommit("retry-response");
  });

  it("commits two documents and publishes process-local state after Postgres commits", async () => {
    const harness = createHarness();
    await harness.seedAndStage("positive-response");

    await expect(harness.commit("positive-response")).resolves.toMatchObject({
      status: "committed",
    });
    await harness.expectSuccessfulCommit("positive-response");
  });

  it("retains mixed provenance across repeated compaction and generation replacement", async () => {
    const harness = createHarness();

    await expect(harness.compactMixedProvenanceTwice()).resolves.toEqual({
      retainedUpdateCount: 0,
      warmProvenance: ["agent", "writer_protected"],
      coldProvenance: ["agent", "writer_protected"],
      rebasedBranchProvenance: ["agent", "writer_protected"],
    });
  });

  it("does not compact a retired-generation suffix into the restored authority head", async () => {
    const harness = createHarness();

    await expect(harness.compactAfterAuthorityReplacement()).resolves.toEqual({
      coldMarkdown: "Restored base.\n",
      currentGenerationUpdateCount: 0,
    });
  });

  it("serializes compaction with concurrent authority-head replacement", async () => {
    const harness = createHarness();

    await expect(harness.compactWhileAuthorityReplacementWaits()).resolves.toEqual({
      coldMarkdown: "Restored base.\n",
      currentGenerationUpdateCount: 0,
    });
  });

  it("aborts every response participant when an outer ambient transaction rolls back later", async () => {
    const harness = createHarness();
    await harness.seedAndStage("outer-rollback-response");
    const before = await harness.captureState();

    await expect(
      runInDrizzleTransaction(db, async () => {
        await harness.commit("outer-rollback-response");
        throw new Error("later outer failure");
      }),
    ).rejects.toThrow("later outer failure");

    expect(await harness.responseJournalRows()).toEqual([]);
    expect(await harness.databaseBranchHashes()).toEqual(before.databaseBranchHashes);
    expect(await harness.threadPeerMarkdown()).toEqual(before.threadPeerMarkdown);
    expect(await harness.workDraftMarkdown()).toEqual(before.workDraftMarkdown);
    expect(harness.stagedUpdates("outer-rollback-response").map((rows) => rows.length)).toEqual([
      1, 1,
    ]);
    expect(harness.pendingWatermarkDocuments()).toEqual([]);
    expect(harness.responseEvents("outer-rollback-response")).not.toContainEqual(
      expect.objectContaining({ transition: "closed" }),
    );
    expect(harness.afterCommitEffects()).toEqual({
      autoPushSchedules: [],
      branchBroadcasts: [],
      watermarkCommits: [],
    });
  });

  it("reports a writer sweep journaled after the observation cut", async () => {
    const harness = createHarness();
    const responseId = "00000000-0000-4000-8000-000000000821";
    await harness.seedProbeTimelineSweep(responseId);

    await expect(harness.commit(responseId)).resolves.toMatchObject({
      status: "committed",
      documents: [
        expect.objectContaining({
          lateSweep: expect.objectContaining({
            affectedBlockHashes: expect.any(Array),
          }),
        }),
      ],
    });
    await harness.waitForAutoPushes();
    expect(harness.afterCommitEffects().autoPushSchedules).toHaveLength(1);
    await harness.autoPush(harness.afterCommitEffects().autoPushSchedules[0] as string);

    const trail = await harness.trailRowMembership();
    expect(trail.shells).toEqual([expect.objectContaining({ changeCount: expect.any(Number) })]);
    expect(trail.shells[0]?.changeCount).toBeGreaterThan(1);
    expect(trail.details).toEqual([
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            beforeText: expect.stringContaining("Writer concurrent edit"),
          }),
        ]),
      }),
    ]);
  });

  it("S10 reports a pulled writer edit that landed after the response read", async () => {
    const harness = createHarness();
    const responseId = "00000000-0000-4000-8000-000000000822";
    await harness.seedProbeTimelineAfterRead(responseId);

    await expect(harness.commit(responseId)).resolves.toMatchObject({
      status: "committed",
      documents: [
        expect.objectContaining({
          lateSweep: expect.objectContaining({ affectedBlockHashes: expect.any(Array) }),
        }),
      ],
    });
    await harness.waitForAutoPushes();
    await harness.autoPush(harness.afterCommitEffects().autoPushSchedules[0] as string);
    await harness.pollTrails();
    await harness.pollTrails();

    const trail = await harness.trailRowMembership();
    expect(trail.shells).toEqual([
      expect.objectContaining({
        state: "settled",
        changeCount: expect.any(Number),
        documentCount: 1,
      }),
    ]);
    expect(trail.shells[0]?.changeCount).toBeGreaterThan(0);
    expect(trail.details).toEqual([
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            beforeText: expect.stringContaining("Writer concurrent edit: Writer block."),
          }),
        ]),
      }),
    ]);
  });

  it("merges a stale whole-document Apply with a writer insertion", async () => {
    const harness = createHarness();
    const responseId = "00000000-0000-4000-8000-000000000835";
    await harness.seedWriterDocument("Writer-approved root.", responseId);
    await harness.stageCertifiedReplace({
      responseId,
      find: "Writer-approved root.",
      content: "STALE DRAFT PROPOSAL",
    });

    const [beforeRow] = await db.select().from(schema.branchWriteJournal);
    if (!beforeRow) throw new Error("missing staged draft row");

    const fixture = harness.crossWorkProbeFixture();
    await fixture.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const before = Y.encodeStateVector(doc);
      const last = fixture.model.getBlocks(toDocHandle(doc)).at(-1) ?? null;
      fixture.model.insertBlocks(
        toDocHandle(doc),
        last,
        fixture.markupCodec.parse("Writer concurrent insertion."),
      );
      await fixture.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });

    const preview = await fixture.collab.draftReview.preview({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: await currentDraftId(fixture.collab.draftReview, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
      }),
    });
    if (preview.status !== "active" || !preview.draftId) {
      throw new Error("missing draft preview");
    }

    const result = await fixture.collab.draftReview.applyWorkDraft({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: preview.draftId,
      userId: USER_ID as never,
    });

    const [afterRow] = await db.select().from(schema.branchWriteJournal);
    expect(afterRow?.draftBaseUpdateSeq).toBe(beforeRow.draftBaseUpdateSeq);
    expect(result).toMatchObject({ status: "applied" });
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toContain("STALE DRAFT PROPOSAL");
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toContain("Writer concurrent insertion.");
  });

  it("applies writer edits added to the draft after the reviewed preview", async () => {
    const harness = createHarness();
    const responseId = "00000000-0000-4000-8000-000000000845";
    await harness.seedWriterDocument("Original draft root.", responseId);
    await harness.stageCertifiedReplace({
      responseId,
      find: "Original draft root.",
      content: "AI DRAFT PROPOSAL",
    });
    const fixture = harness.crossWorkProbeFixture();
    const reviewed = await fixture.collab.draftReview.preview({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: await currentDraftId(fixture.collab.draftReview, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
      }),
    });
    if (reviewed.status !== "active" || !reviewed.draftId) {
      throw new Error("missing reviewed draft preview");
    }
    const branch = await fixture.liveCoordinator.withDocument(ALPHA_ID, (liveDoc) =>
      fixture.branchStore.resolveWorkDraftBranchForWork({
        documentId: ALPHA_ID,
        workId: WORK_ID,
        liveDoc,
      }),
    );
    const block = fixture.model.getBlocks(toDocHandle(branch.doc))[0];
    if (!block) throw new Error("draft writer block missing");
    const draftTextLength = fixture.model.getText(block).length;
    fixture.model.applyTextEdit(
      toDocHandle(branch.doc),
      block,
      { from: draftTextLength, to: draftTextLength },
      " WRITER DRAFT MARKER",
    );
    const committed = await fixture.branchCoordinator.commitSyncFromDoc({
      branchId: branch.branchId,
      sourceDoc: branch.doc,
      expectedGeneration: branch.generation,
      source: "writer",
      actorUserId: USER_ID as never,
      threadId: null,
      turnId: null,
      wId: null,
      updateMeta: null,
    });
    branch.doc.destroy();
    expect(committed).toBe(true);

    const current = await fixture.collab.draftReview.preview({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: await currentDraftId(fixture.collab.draftReview, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
      }),
    });
    expect(current).toMatchObject({
      status: "active",
      operations: expect.arrayContaining([
        expect.objectContaining({ kind: "writer", actorUserId: USER_ID }),
      ]),
    });

    await expect(
      fixture.collab.draftReview.applyWorkDraft({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: reviewed.draftId,
        userId: USER_ID as never,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toContain("AI DRAFT PROPOSAL");
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toContain("WRITER DRAFT MARKER");
    await expect(
      fixture.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).resolves.toMatchObject({ status: "cant_undo_dependent" });
    await expect(
      fixture.collab.draftReview.list({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
      }),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({ id: schema.branchWriteJournal.id })
        .from(schema.branchWriteJournal)
        .where(
          and(
            eq(schema.branchWriteJournal.branchId, reviewed.draftId),
            inArray(schema.branchWriteJournal.status, ["active", "rollback_pending"]),
          ),
        ),
    ).resolves.toEqual([]);
  });

  it("preserves an unrelated live writer insertion while applying the branch", async () => {
    const harness = createHarness();
    const responseId = "00000000-0000-4000-8000-000000000836";
    await harness.seedWriterDocument("Selected root.\n\nUntouched root.", responseId);
    await harness.stageCertifiedReplace({
      responseId,
      find: "Selected root.",
      content: "SELECTIVE DRAFT PROPOSAL",
    });

    const fixture = harness.crossWorkProbeFixture();
    await fixture.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const before = Y.encodeStateVector(doc);
      const last = fixture.model.getBlocks(toDocHandle(doc)).at(-1) ?? null;
      fixture.model.insertBlocks(
        toDocHandle(doc),
        last,
        fixture.markupCodec.parse("Writer concurrent insertion."),
      );
      await fixture.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });

    const preview = await fixture.collab.draftReview.preview({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: await currentDraftId(fixture.collab.draftReview, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
      }),
    });
    if (preview.status !== "active" || !preview.draftId) {
      throw new Error("missing draft preview");
    }

    await expect(
      fixture.collab.draftReview.applyWorkDraft({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: preview.draftId,
        userId: USER_ID as never,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toContain("Writer concurrent insertion.");
  });

  it("preserves a live writer insertion between two branch edits", async () => {
    const harness = createHarness();
    const responseId = "00000000-0000-4000-8000-000000000837";
    await harness.seedWriterDocument("Left root.\n\nRight root.", responseId);
    const fixture = harness.crossWorkProbeFixture();
    const context = {
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId,
    };
    await expect(
      fixture.collab.agentEdit().write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "Left root.",
          content: "LEFT DRAFT",
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    await expect(
      fixture.collab.agentEdit().write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "Right root.",
          content: "RIGHT DRAFT",
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    await expect(
      fixture.collab.finalizeResponseCommit(responseId, {
        threadId: THREAD_ID,
        turnId: context.turnId as never,
      }),
    ).resolves.toMatchObject({ status: "committed" });

    await fixture.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const before = Y.encodeStateVector(doc);
      const first = fixture.model.getBlocks(toDocHandle(doc))[0] ?? null;
      fixture.model.insertBlocks(
        toDocHandle(doc),
        first,
        fixture.markupCodec.parse("Writer middle insertion."),
      );
      await fixture.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });

    const preview = await fixture.collab.draftReview.preview({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: await currentDraftId(fixture.collab.draftReview, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
      }),
    });
    if (preview.status !== "active" || !preview.draftId) {
      throw new Error("missing draft preview");
    }
    await expect(
      fixture.collab.draftReview.applyWorkDraft({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: preview.draftId,
        userId: USER_ID as never,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toBe(
      "LEFT DRAFT\n\nWriter middle insertion.\n\nRIGHT DRAFT\n",
    );
  });

  it("merges a folded whole-document overwrite with a later writer insertion", async () => {
    const harness = createHarness();
    const responseId = "00000000-0000-4000-8000-000000000838";
    await harness.seedWriterDocument("First writer root.\n\nSecond writer root.", responseId);
    const fixture = harness.crossWorkProbeFixture();
    const context = {
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId,
      createdDocument: false,
    };
    await expect(
      fixture.collab.agentEdit().write(
        {
          command: "create",
          file: "alpha.md",
          documentId: ALPHA_ID,
          content: "WHOLE DRAFT\n\nDraft tail.",
          overwrite: true,
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    await expect(
      fixture.collab.agentEdit().write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "WHOLE DRAFT",
          content: "REFINED WHOLE DRAFT",
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    await expect(
      fixture.collab.finalizeResponseCommit(responseId, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).resolves.toMatchObject({ status: "committed" });

    await fixture.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const before = Y.encodeStateVector(doc);
      const last = fixture.model.getBlocks(toDocHandle(doc)).at(-1) ?? null;
      fixture.model.insertBlocks(
        toDocHandle(doc),
        last,
        fixture.markupCodec.parse("Writer insertion after overwrite base."),
      );
      await fixture.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });

    const preview = await fixture.collab.draftReview.preview({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: await currentDraftId(fixture.collab.draftReview, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
      }),
    });
    if (preview.status !== "active" || !preview.draftId) {
      throw new Error("missing draft preview");
    }
    await expect(
      fixture.collab.draftReview.applyWorkDraft({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: preview.draftId,
        userId: USER_ID as never,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toContain("REFINED WHOLE DRAFT");
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toContain(
      "Writer insertion after overwrite base.",
    );
  });
});
