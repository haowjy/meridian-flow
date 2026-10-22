import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  runInDrizzleTransaction,
  schema,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

const _DRAFT_DESTINATION = { kind: "draft", workId: WORK_ID, workHandle: "w1" } as const;

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

// A live write records its authoring response, so this reply is a real response row.
const MIXED_RETRY_RESPONSE = "00000000-0000-4000-8000-000000000831";

describe("change trail (postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeDatabase(db));

  it.each([
    false,
    true,
  ])("a post-root refresh failure cannot reopen or skip later documents in committed response (mixed=%s)", async (liveBeta) => {
    const harness = createHarness(db);
    const responseId = "00000000-0000-4000-8000-000000000832";
    await harness.seedAndStage(responseId, { liveBeta });
    harness.failFirstRefresh = true;
    await expect(harness.commit(responseId)).resolves.toMatchObject({ status: "committed" });
    expect(harness.refreshObservedDurability).toBe(true);
    // The failed first refresh must not stop the second document's.
    expect(new Set(harness.refreshedDocuments)).toEqual(new Set([ALPHA_ID, BETA_ID]));
    expect(harness.responseEvents(responseId)).toContainEqual(
      expect.objectContaining({ transition: "closed" }),
    );
    expect(harness.stagedUpdates(responseId)).toEqual([[], []]);
    const draftText = await harness.workDraftMarkdown();
    expect(draftText).toContainEqual(expect.stringContaining("Agent alpha."));
    if (liveBeta) expect(await harness.liveMarkdown(BETA_ID)).toContain("Agent beta.");
    else expect(draftText).toContainEqual(expect.stringContaining("Agent beta."));
    expect(
      await db.select().from(schema.documentEdits).where(eq(schema.documentEdits.kind, "rollback")),
    ).toEqual([]);
    expect(await harness.responseJournalRows()).not.toEqual([]);
  });

  it("rolls back every state surface and commits the retained response on retry", async () => {
    const harness = createHarness(db);
    await harness.seedAndStage("retry-response");
    const before = await harness.captureState();
    const staged = harness.stagedUpdates("retry-response");

    harness.failSecondJournalInsert = true;
    await expect(harness.commit("retry-response")).rejects.toThrow(
      "injected second-document journal failure",
    );

    // Amendment-2 §F's rollback surfaces, kept explicit so a regression names its leak.
    expect(await harness.responseJournalRows()).toEqual([]); // 1. Postgres journal
    expect(await harness.databaseDraftHashes()).toEqual(before.databaseDraftHashes); // 2. snapshots
    expect(await harness.threadPeerMarkdown()).toEqual(before.threadPeerMarkdown); // 3. peer cache
    expect(await harness.workDraftMarkdown()).toEqual(before.workDraftMarkdown); // 4. draft cache
    expect(harness.stagedUpdates("retry-response").map((updates) => updates.length)).toEqual([
      1, 1,
    ]); // 5. facade still owns the response
    expect(harness.stagedUpdates("retry-response")).toEqual(staged); // 6. raw staged updates retained
    expect(harness.responseEvents("retry-response")).not.toContainEqual(
      expect.objectContaining({ transition: "closed" }),
    ); // 7. lifecycle not closed (retained buffers prove buffered ownership)
    expect(harness.afterCommitEffects()).toEqual({
      draftBroadcasts: [],
    }); // 8. callbacks not dispatched
    expect(harness.openRoomIds()).toEqual([ALPHA_ID, BETA_ID]);
    expect(harness.liveRoomBroadcasts()).toEqual([]);
    // 9. No notices persisted; this scenario does not engage the producer. The
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

  // D42: a mixed save that fails after beta's live append leaves nothing, live or drafted.
  it("rolls back a live and a drafted document when the save fails after the live append", async () => {
    const harness = createHarness(db);
    await harness.seedAndStage(MIXED_RETRY_RESPONSE, { liveBeta: true });
    const before = await harness.captureState();
    const liveBeta = await harness.liveMarkdown(BETA_ID);

    // Beta's live append runs first; alpha's draft journal insert then fails.
    harness.failJournalInsertAt = 1;
    await expect(harness.commit(MIXED_RETRY_RESPONSE)).rejects.toThrow(
      "injected draft journal failure",
    );

    expect(await harness.liveMarkdown(BETA_ID)).toBe(liveBeta);
    expect(await harness.liveAgentUpdateCount(BETA_ID)).toBe(0);
    expect(await harness.responseJournalRows()).toEqual([]);
    expect(await harness.workDraftMarkdown()).toEqual(before.workDraftMarkdown);
    expect(harness.liveRoomBroadcasts()).toEqual([]);

    harness.failJournalInsertAt = null;
    await expect(harness.commit(MIXED_RETRY_RESPONSE)).resolves.toMatchObject({
      status: "committed",
    });
    expect(await harness.liveMarkdown(BETA_ID)).toContain("Agent beta.");
  });

  it("retains mixed provenance across repeated compaction and generation replacement", async () => {
    const harness = createHarness(db);

    await expect(harness.compactMixedProvenanceTwice()).resolves.toEqual({
      retainedUpdateCount: 0,
      warmProvenance: ["agent", "writer_protected"],
      coldProvenance: ["agent", "writer_protected"],
      rebasedDraftProvenance: ["agent", "writer_protected"],
    });
  });

  it("does not compact a retired-generation suffix into the restored authority head", async () => {
    const harness = createHarness(db);

    await expect(harness.compactAfterAuthorityReplacement()).resolves.toEqual({
      coldMarkdown: "Restored base.\n",
      currentGenerationUpdateCount: 0,
    });
  });

  it("serializes compaction with concurrent authority-head replacement", async () => {
    const harness = createHarness(db);

    await expect(harness.compactWhileAuthorityReplacementWaits()).resolves.toEqual({
      coldMarkdown: "Restored base.\n",
      currentGenerationUpdateCount: 0,
    });
  });

  it("aborts every response participant when an outer ambient transaction rolls back later", async () => {
    const harness = createHarness(db);
    await harness.seedAndStage("outer-rollback-response");
    const before = await harness.captureState();

    await expect(
      runInDrizzleTransaction(db, async () => {
        await harness.commit("outer-rollback-response");
        throw new Error("later outer failure");
      }),
    ).rejects.toThrow("later outer failure");

    expect(await harness.responseJournalRows()).toEqual([]);
    expect(await harness.databaseDraftHashes()).toEqual(before.databaseDraftHashes);
    expect(await harness.threadPeerMarkdown()).toEqual(before.threadPeerMarkdown);
    expect(await harness.workDraftMarkdown()).toEqual(before.workDraftMarkdown);
    expect(harness.stagedUpdates("outer-rollback-response").map((rows) => rows.length)).toEqual([
      1, 1,
    ]);
    expect(harness.responseEvents("outer-rollback-response")).not.toContainEqual(
      expect.objectContaining({ transition: "closed" }),
    );
    expect(harness.afterCommitEffects()).toEqual({
      draftBroadcasts: [],
    });
  });
});
