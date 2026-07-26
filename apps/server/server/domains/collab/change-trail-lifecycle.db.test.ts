import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleDocumentAccess } from "../../lib/document-access.js";
import { createDrizzleChangeTrailReader } from "./adapters/drizzle-change-trail-reader.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  db,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./test-support/change-trail-postgres-harness.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

describe("change trail (postgres)", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("S10 settles multiple durable writes after the turn errors into one reachable trail", async () => {
    let committed = 0;
    let release!: () => void;
    let allCommitted!: () => void;
    const settlementRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const durableWritesCommitted = new Promise<void>((resolve) => {
      allCommitted = resolve;
    });
    const warm = createHarness({
      async afterDurableCommit() {
        committed += 1;
        if (committed === 2) allCommitted();
        await settlementRelease;
      },
    });
    const alpha = await warm.seedDestructivePush("s10-alpha", ALPHA_ID);
    const beta = await warm.seedDestructivePush("s10-beta", BETA_ID);
    const alphaSettlement = warm.autoPush(alpha);
    const betaSettlement = warm.autoPush(beta);
    await durableWritesCommitted;

    await warm.markTurnError();
    expect(await db.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID))).toEqual([
      expect.objectContaining({ status: "error" }),
    ]);
    expect(await db.select().from(schema.changeTrailShells)).toEqual([
      expect.objectContaining({ state: "building", changeCount: 2, documentCount: 2 }),
    ]);
    release();
    await expect(Promise.all([alphaSettlement, betaSettlement])).resolves.toEqual([
      expect.objectContaining({ status: "pushed" }),
      expect.objectContaining({ status: "pushed" }),
    ]);
    warm.destroyWarmState();

    const cold = createHarness();
    await cold.pollTrails();
    await cold.pollTrails();
    const trails = await cold.trailRows();
    expect(trails.shells).toEqual([
      expect.objectContaining({
        ownerKind: "turn",
        turnId: TURN_ID,
        state: "settled",
        documentCount: 2,
        documents: [
          { documentId: ALPHA_ID, title: "alpha" },
          { documentId: BETA_ID, title: "beta" },
        ],
        wordsAdded: 0,
        wordsRemoved: 10,
      }),
    ]);
    expect(trails.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: ALPHA_ID, wordsAdded: 0, wordsRemoved: 5 }),
        expect.objectContaining({ documentId: BETA_ID, wordsAdded: 0, wordsRemoved: 5 }),
      ]),
    );
    expect(
      trails.details.flatMap((detail) =>
        (detail.changes as Array<{ beforeText?: string | null }>).flatMap((change) => {
          if (!change.beforeText) return [];
          const separator = change.beforeText.indexOf("|");
          return [separator < 0 ? change.beforeText : change.beforeText.slice(separator + 1)];
        }),
      ),
    ).toEqual([
      expect.stringContaining("Writer captured body"),
      expect.stringContaining("Writer captured body"),
    ]);
    const reader = createDrizzleChangeTrailReader(db, createDrizzleDocumentAccess(db));
    await expect(reader.listShells(THREAD_ID)).resolves.toEqual([
      expect.objectContaining({
        documents: [
          { documentId: ALPHA_ID, title: "alpha" },
          { documentId: BETA_ID, title: "beta" },
        ],
        wordsAdded: 0,
        wordsRemoved: 10,
      }),
    ]);
    const trailId = trails.shells[0]?.id;
    if (!trailId) throw new Error("missing settled trail");
    await expect(
      reader.readDetails({ threadId: THREAD_ID, trailId, userId: USER_ID }),
    ).resolves.toEqual([
      expect.objectContaining({ documentId: ALPHA_ID, wordsAdded: 0, wordsRemoved: 5 }),
      expect.objectContaining({ documentId: BETA_ID, wordsAdded: 0, wordsRemoved: 5 }),
    ]);
    cold.destroyWarmState();
  });

  it("persists prose-token deltas for a one-word substitution", async () => {
    const harness = createHarness();
    const branchId = await harness.seedMatrixPush({
      responseId: "word-delta-substitution",
      initialMarkdown: "The gate remained closed.",
      steps: [{ source: "agent", markdown: "The gate opened." }],
    });

    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    await harness.markTurnError();
    await harness.pollTrails();
    await harness.pollTrails();

    const trails = await harness.trailRows();
    expect(trails.shells).toEqual([
      expect.objectContaining({ state: "settled", wordsAdded: 1, wordsRemoved: 2 }),
    ]);
    expect(trails.details).toEqual([
      expect.objectContaining({ documentId: ALPHA_ID, wordsAdded: 1, wordsRemoved: 2 }),
    ]);
    harness.destroyWarmState();
  });

  it("retains captured trail prose after the file is permanently deleted", async () => {
    const trailId = "00000000-0000-4000-8000-000000000810";
    await db.insert(schema.changeTrailShells).values({
      id: trailId,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      ownerKind: "turn",
      changeCount: 1,
      documentCount: 1,
    });
    await db
      .insert(schema.changeTrailDocumentOccurrences)
      .values({ trailId, documentId: ALPHA_ID });
    await db.insert(schema.changeTrailDocumentDetails).values({
      trailId,
      documentId: ALPHA_ID,
      documentTitle: "Deleted chapter",
      changes: [
        {
          changeId: "captured-change",
          ordinal: 0,
          documentId: ALPHA_ID,
          pushId: null,
          receiptId: null,
          kind: "delete",
          beforeText: "deleted-block|Captured after reload.",
          afterTextAtReceipt: null,
          beforeBlockIdentity: null,
          afterBlockIdentity: null,
          navigation: { kind: "unavailable", reason: "document_deleted" },
        },
      ],
    });
    await db
      .update(schema.documents)
      .set({ deletedAt: new Date() })
      .where(eq(schema.documents.id, ALPHA_ID));

    const reader = createDrizzleChangeTrailReader(db, createDrizzleDocumentAccess(db));
    await expect(
      reader.readDetails({ threadId: THREAD_ID, trailId, userId: USER_ID }),
    ).resolves.toEqual([
      expect.objectContaining({
        documentId: ALPHA_ID,
        anchorState: "deleted",
        changes: [
          expect.objectContaining({
            beforeText: "deleted-block|Captured after reload.",
          }),
        ],
      }),
    ]);
  });

  it("returns no protected trail detail when document authorization fails", async () => {
    const trailId = "00000000-0000-4000-8000-000000000811";
    await db.insert(schema.changeTrailShells).values({
      id: trailId,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      ownerKind: "turn",
      changeCount: 1,
      documentCount: 1,
    });
    await db
      .insert(schema.changeTrailDocumentOccurrences)
      .values({ trailId, documentId: ALPHA_ID });
    await db.insert(schema.changeTrailDocumentDetails).values({
      trailId,
      documentId: ALPHA_ID,
      documentTitle: "Protected chapter",
      changes: [
        {
          changeId: "protected-change",
          ordinal: 0,
          documentId: ALPHA_ID,
          pushId: null,
          receiptId: null,
          kind: "delete",
          beforeText: "protected-block|Protected prose.",
          afterTextAtReceipt: null,
          beforeBlockIdentity: null,
          afterBlockIdentity: null,
          navigation: { kind: "unavailable", reason: "test" },
        },
      ],
    });

    const reader = createDrizzleChangeTrailReader(db, createDrizzleDocumentAccess(db));
    await expect(
      reader.readDetails({
        threadId: THREAD_ID,
        trailId,
        userId: "00000000-0000-4000-8000-000000000812" as never,
      }),
    ).resolves.toEqual([]);

    const revokedAccess = {
      documentAccessState: async () => "available" as const,
      lockDocumentAccessState: async () => null,
    };
    await expect(
      createDrizzleChangeTrailReader(db, revokedAccess).readDetails({
        threadId: THREAD_ID,
        trailId,
        userId: USER_ID,
      }),
    ).resolves.toEqual([]);
  });

  it("settles manual-policy turn work through a durable no-op", async () => {
    const harness = createHarness();
    await harness.seedDestructivePush("manual-policy-settlement");

    await harness.pollTrails();
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "no_op", attempts: 0 }),
    ]);
    expect(await harness.trailRows()).toMatchObject({
      shells: [expect.objectContaining({ state: "settling", version: 2 })],
      details: [],
      outbox: [expect.objectContaining({ eventKind: "updated", version: 2 })],
    });

    await harness.pollTrails();
    expect(await harness.trailRows()).toMatchObject({
      shells: [
        expect.objectContaining({
          state: "settled",
          version: 3,
          changeCount: 0,
          documentCount: 0,
          settledAt: expect.any(Date),
        }),
      ],
      details: [],
      outbox: [
        expect.objectContaining({ eventKind: "updated", version: 2 }),
        expect.objectContaining({ eventKind: "settled", version: 3 }),
      ],
    });
  });

  it("retries an auto-push without re-entering the shared branch mutex", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("retry-shared-mutex");
    await harness.setPushPolicy("auto");
    harness.failNextTrailRetry();

    await harness.pollTrails();
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "pending", attempts: 1 }),
    ]);

    harness.advanceTrailWorkTime(2_000);
    await expect(harness.pollTrails()).resolves.toEqual(expect.any(Number));
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "complete", attempts: 2 }),
    ]);
    expect(await harness.branchGeneration(branchId)).toBe(2);

    await harness.stageAnotherDestructiveEdit(branchId);
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    expect(await harness.branchGeneration(branchId)).toBe(3);
  });

  it("claims pending trail work only when its retry deadline arrives", async () => {
    const harness = createHarness();
    await harness.seedDestructivePush("retry-deadline");
    await harness.setPushPolicy("auto");
    await harness.deferTrailWork(2_000);

    harness.advanceTrailWorkTime(1_999);
    await harness.pollTrails();
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "pending", attempts: 0 }),
    ]);

    harness.advanceTrailWorkTime(1);
    await harness.pollTrails();
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "complete", attempts: 1 }),
    ]);
  });

  it("reclaims running trail work only after its lease expires", async () => {
    const harness = createHarness();
    await harness.seedDestructivePush("running-lease");
    await harness.setPushPolicy("auto");
    await harness.markTrailWorkRunning();

    harness.advanceTrailWorkTime(30_000);
    await harness.pollTrails();
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "running", attempts: 0 }),
    ]);

    harness.advanceTrailWorkTime(1);
    await harness.pollTrails();
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "complete", attempts: 1 }),
    ]);
  });

  it("fences exhausted auto-push work without falsely settling its trail", async () => {
    const harness = createHarness();
    await harness.seedDestructivePush("exhausted-auto-push");
    await harness.setPushPolicy("auto");
    harness.failAllTrailRetries();

    for (const delay of [0, 2_000, 4_000, 8_000, 16_000]) {
      harness.advanceTrailWorkTime(delay);
      await harness.pollTrails();
    }

    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "exhausted", attempts: 5 }),
    ]);
    expect(harness.exhaustionFences()).toEqual([{ threadId: THREAD_ID, documentId: ALPHA_ID }]);
    expect(await harness.trailRows()).toMatchObject({
      shells: [expect.objectContaining({ state: "settling", settledAt: null })],
      details: [],
      outbox: [expect.objectContaining({ eventKind: "updated" })],
    });
  });

  it("does not synthesize a shared trail from mixed journal ownership", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("shared-settlement");
    await harness.makeJournalOwnershipMixed();
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });

    await harness.pollTrails();
    await harness.pollTrails();

    const rows = await harness.trailRows();
    expect(rows.shells).toEqual([
      expect.objectContaining({
        ownerKind: "turn",
        state: "settled",
        settledAt: expect.any(Date),
      }),
    ]);
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ turnId: TURN_ID, state: "complete" }),
    ]);
    for (const shell of rows.shells) {
      expect(
        rows.outbox
          .filter((row) => row.trailId === shell.id)
          .map((row) => [row.version, row.eventKind]),
      ).toEqual(expect.arrayContaining([[shell.version, "settled"]]));
    }
  });

  it("settles a shared trail whose changes have no turn-owned work rows", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("all-null-shared-settlement");
    await harness.makeJournalOwnershipNull();
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    expect(await harness.workRows()).toEqual([]);

    await harness.pollTrails();
    await harness.pollTrails();

    expect(await harness.trailRows()).toMatchObject({
      shells: [
        expect.objectContaining({
          ownerKind: "shared",
          state: "settled",
          changeCount: 1,
          documentCount: 1,
        }),
      ],
      details: [expect.objectContaining({ changes: [expect.any(Object)] })],
    });
  });

  it("serializes concurrent per-document trail versions without losing either push", async () => {
    const harness = createHarness();
    const alpha = await harness.seedDestructivePush("version-race-alpha", ALPHA_ID);
    const beta = await harness.seedDestructivePush("version-race-beta", BETA_ID);

    await expect(Promise.all([harness.autoPush(alpha), harness.autoPush(beta)])).resolves.toEqual([
      expect.objectContaining({ status: "pushed" }),
      expect.objectContaining({ status: "pushed" }),
    ]);
    const rows = await harness.trailRows();
    expect(rows.shells).toEqual([expect.objectContaining({ version: 2, documentCount: 2 })]);
    expect(rows.details.map((row) => row.documentId).sort()).toEqual([ALPHA_ID, BETA_ID]);
    expect(rows.outbox.map((row) => row.version).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(
      new Set(rows.outbox.map((row) => `${row.trailId}:${row.version}:${row.eventKind}`)).size,
    ).toBe(rows.outbox.length);
    expect(await harness.pushRows()).toHaveLength(2);
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "complete" }),
      expect.objectContaining({ state: "complete" }),
    ]);
  });

  it("serializes shared recording against terminal reconciliation", async () => {
    const harness = createHarness();
    const first = await harness.seedDestructivePush("shared-record-reconcile-first", ALPHA_ID);
    await harness.makeJournalOwnershipNull();
    await harness.autoPush(first);
    await harness.pollTrails();

    const second = await harness.seedDestructivePush("shared-record-reconcile-second", BETA_ID);
    await harness.makeJournalOwnershipNull();
    await expect(Promise.all([harness.autoPush(second), harness.pollTrails()])).resolves.toEqual([
      expect.objectContaining({ status: "pushed" }),
      expect.any(Number),
    ]);

    const rows = await harness.trailRows();
    const shared = rows.shells.find((shell) => shell.ownerKind === "shared");
    expect(shared).toMatchObject({ documentCount: 2 });
    const sharedEvents = rows.outbox.filter((row) => row.trailId === shared?.id);
    expect(new Set(sharedEvents.map((row) => `${row.version}:${row.eventKind}`)).size).toBe(
      sharedEvents.length,
    );
  });

  it("uses one sorted lock order for combined shared and turn reconciliation", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("combined-lock-order");
    await harness.makeJournalOwnershipMixed();
    await harness.autoPush(branchId);
    await harness.stageAnotherDestructiveEdit(branchId);
    await harness.makeJournalOwnershipMixed();

    await expect(
      Promise.race([
        Promise.all([harness.autoPush(branchId), harness.pollTrails()]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("aggregate lock-order deadlock")), 5_000),
        ),
      ]),
    ).resolves.toEqual([expect.objectContaining({ status: "pushed" }), expect.any(Number)]);
  });

  it("reopens and re-settles a settled trail when branch work is redone", async () => {
    const harness = createHarness();
    await harness.seedDestructivePush("redo-after-settled");

    await harness.pollTrails();
    await harness.pollTrails();
    const [settled] = (await harness.trailRows()).shells;
    expect(settled).toMatchObject({
      state: "settled",
      version: 3,
      settledAt: expect.any(Date),
      changeCount: 0,
      documentCount: 0,
    });

    await expect(harness.reverseTurn("undo")).resolves.toMatchObject({ status: "reversed" });
    await harness.setPushPolicy("auto");
    await expect(harness.reverseTurn("redo")).resolves.toMatchObject({ status: "reconciled" });

    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "pending", attempts: 0 }),
    ]);
    const reopened = await harness.trailRows();
    expect(reopened.shells).toEqual([
      expect.objectContaining({ state: "building", version: 4, settledAt: null }),
    ]);
    expect(reopened.outbox.map((row) => [row.version, row.eventKind])).toEqual([
      [2, "updated"],
      [3, "settled"],
      [4, "updated"],
    ]);

    await harness.pollTrails();
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "complete", attempts: 1 }),
    ]);
    expect((await harness.trailRows()).shells).toEqual([
      expect.objectContaining({ state: "settling", version: 6, settledAt: null }),
    ]);

    await harness.pollTrails();
    const resettled = await harness.trailRows();
    expect(resettled.shells).toEqual([
      expect.objectContaining({
        state: "settled",
        version: 7,
        settledAt: expect.any(Date),
        changeCount: 1,
        documentCount: 1,
      }),
    ]);
    expect(resettled.outbox.map((row) => [row.version, row.eventKind])).toEqual([
      [2, "updated"],
      [3, "settled"],
      [4, "updated"],
      [5, "updated"],
      [6, "updated"],
      [7, "settled"],
    ]);
    expect(
      resettled.outbox.find((row) => row.version === 7 && row.eventKind === "settled"),
    ).toMatchObject({
      changeCount: 1,
      documentCount: 1,
      documents: [expect.objectContaining({ documentId: ALPHA_ID })],
      wordsAdded: expect.any(Number),
      wordsRemoved: expect.any(Number),
    });
  });

  it("rebuilds an errored turn trail from surviving durable content", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("error-rebuild");
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    expect((await harness.trailRows()).details).toHaveLength(1);

    await harness.addLiveDependency();
    await harness.rollbackResponse("later-failed-response");
    await harness.markTurnError();
    await harness.pollTrails();
    await harness.pollTrails();

    expect(await harness.workRows()).toEqual([expect.objectContaining({ state: "complete" })]);
    expect(await harness.trailRows()).toMatchObject({
      shells: [
        expect.objectContaining({
          state: "settled",
          changeCount: 1,
          documentCount: 1,
        }),
      ],
      details: [expect.objectContaining({ changes: [expect.any(Object)] })],
    });
  });
});
