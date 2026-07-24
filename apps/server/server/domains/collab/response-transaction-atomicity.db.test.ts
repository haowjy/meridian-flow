import { toDocHandle } from "@meridian/agent-edit";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
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

  it("does not compact a retired-generation suffix into restored authority", async () => {
    const harness = createHarness();

    await expect(harness.compactAfterAuthorityReplacement()).resolves.toEqual({
      coldMarkdown: "Restored base.\n",
      currentGenerationUpdateCount: 0,
    });
  });

  it("serializes compaction with concurrent authority replacement", async () => {
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

  it("rolls back an attempted late-sweep notice with its ambient transaction, then persists it on commit", async () => {
    const harness = createHarness();
    const responseId = "late-sweep-notice-response";
    await harness.seedAndStageDestructive(responseId);

    await expect(
      runInDrizzleTransaction(db, async () => {
        await expect(harness.commit(responseId)).resolves.toMatchObject({
          status: "committed",
          documents: [
            expect.objectContaining({
              documentId: ALPHA_ID,
              lateSweep: expect.objectContaining({ affectedBlockHashes: expect.any(Array) }),
            }),
          ],
        });
        throw new Error("failure after late-sweep notice recording");
      }),
    ).rejects.toThrow("failure after late-sweep notice recording");

    expect(harness.noticeRecordAttempts()).toBeGreaterThan(0);
    expect(await harness.noticeRows()).toEqual([]);

    const commitHarness = createHarness();
    const commitResponseId = "late-sweep-notice-commit-response";
    await commitHarness.seedAndStageDestructive(commitResponseId, BETA_ID);
    await expect(commitHarness.commit(commitResponseId)).resolves.toMatchObject({
      status: "committed",
      documents: [expect.objectContaining({ lateSweep: expect.any(Object) })],
    });
    expect(await commitHarness.noticeRows()).toEqual([
      expect.objectContaining({ kind: "late_sweep", scopeKind: "thread", scopeId: THREAD_ID }),
    ]);
  });

  it("persists a writer edit journaled after the response read as swept", async () => {
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

    const trail = await harness.trailRows();
    expect(trail.shells).toEqual([
      expect.objectContaining({ sweptChangeCount: 3, changeCount: expect.any(Number) }),
    ]);
    expect(trail.shells[0]?.changeCount).toBeGreaterThan(1);
    expect(trail.details).toEqual([
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            beforeText: expect.stringContaining("Writer concurrent edit"),
            swept: expect.objectContaining({
              removed: expect.objectContaining({
                status: "available",
                markdown: expect.stringContaining("Writer concurrent edit"),
              }),
            }),
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

    const trail = await harness.trailRows();
    expect(trail.shells).toEqual([
      expect.objectContaining({
        state: "settled",
        sweptChangeCount: 3,
        changeCount: expect.any(Number),
        documentCount: 1,
      }),
    ]);
    expect(trail.shells[0]?.changeCount).toBeGreaterThan(0);
    expect(trail.details).toEqual([
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            swept: expect.objectContaining({
              removed: expect.objectContaining({
                status: "available",
                markdown: expect.stringContaining("Writer concurrent edit"),
              }),
            }),
            beforeText: expect.stringContaining("Writer concurrent edit: Writer block."),
          }),
        ]),
      }),
    ]);
  });

  it("refuses a stale whole-document Apply that encloses a writer insertion", async () => {
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
    });
    if (preview.status !== "active" || !preview.branchId) {
      throw new Error("missing draft preview");
    }

    const beforeApply = await harness.liveMarkdown(ALPHA_ID);
    const result = await fixture.collab.draftReview.accept({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
      documentId: ALPHA_ID,
      branchId: preview.branchId,
      userId: USER_ID as never,
      draftRevisionToken: preview.draftRevisionToken,
      operationIds: preview.operations.map((operation) => operation.operationId),
    });

    const [afterRow] = await db.select().from(schema.branchWriteJournal);
    expect(afterRow?.draftBaseUpdateSeq).toBe(beforeRow.draftBaseUpdateSeq);
    expect(result).toMatchObject({
      status: "concurrent_conflict",
      reason: "draft_base_divergence",
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(beforeApply);
  });

  it("applies a stale selective edit that does not enclose a writer insertion", async () => {
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
    });
    if (preview.status !== "active" || !preview.branchId) {
      throw new Error("missing draft preview");
    }

    await expect(
      fixture.collab.draftReview.accept({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        branchId: preview.branchId,
        userId: USER_ID as never,
        draftRevisionToken: preview.draftRevisionToken,
        operationIds: preview.operations.map((operation) => operation.operationId),
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toContain("Writer concurrent insertion.");
  });

  it("does not join separate selective edits into an enclosing replacement scope", async () => {
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
    });
    if (preview.status !== "active" || !preview.branchId) {
      throw new Error("missing draft preview");
    }
    await expect(
      fixture.collab.draftReview.accept({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        branchId: preview.branchId,
        userId: USER_ID as never,
        draftRevisionToken: preview.draftRevisionToken,
        operationIds: preview.operations.map((operation) => operation.operationId),
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toBe(
      "LEFT DRAFT\n\nWriter middle insertion.\n\nRIGHT DRAFT\n",
    );
  });
});
