import { splitHashline } from "@meridian/agent-edit";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleFileAccess } from "../../test-support/file-grants.js";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import { createDrizzleChangeTrailReader } from "./adapters/drizzle-change-trail-reader.js";
import { invalidateTrailOwners } from "./adapters/drizzle-trail-owners.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
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
  const db = createTestDatabase();
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeDatabase(db));

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
    const warm = createHarness(db, {
      async afterDurableCommit() {
        committed += 1;
        if (committed === 2) allCommitted();
        await settlementRelease;
      },
    });
    const alpha = await warm.seedDestructivePush("s10-alpha", ALPHA_ID);
    const beta = await warm.seedDestructivePush("s10-beta", BETA_ID);
    const alphaSettlement = warm.push(alpha);
    const betaSettlement = warm.push(beta);
    await durableWritesCommitted;

    await warm.markTurnError();
    expect(await db.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID))).toEqual([
      expect.objectContaining({ status: "error" }),
    ]);
    expect(await db.select().from(schema.changeTrailShells)).toEqual([
      expect.objectContaining({ state: "building", changeCount: 2, documentCount: 2 }),
    ]);
    await warm.pollTrails();
    await warm.pollTrails();
    expect((await warm.trailRowMembership()).shells).toEqual([
      expect.objectContaining({ state: "settling" }),
    ]);
    expect((await warm.trailEventSequence()).every((row) => row.eventKind !== "settled")).toBe(
      true,
    );
    release();
    await expect(Promise.all([alphaSettlement, betaSettlement])).resolves.toEqual([
      expect.objectContaining({ status: "pushed" }),
      expect.objectContaining({ status: "pushed" }),
    ]);
    warm.destroyWarmState();

    const cold = createHarness(db);
    await cold.pollTrails();
    await cold.pollTrails();
    const trails = await cold.trailRowMembership();
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
          return [splitHashline(change.beforeText)?.body ?? change.beforeText];
        }),
      ),
    ).toEqual([
      expect.stringContaining("Writer captured body"),
      expect.stringContaining("Writer captured body"),
    ]);
    const reader = createDrizzleChangeTrailReader(db, drizzleFileAccess(db));
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

    const reader = createDrizzleChangeTrailReader(db, drizzleFileAccess(db));
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

    const reader = createDrizzleChangeTrailReader(db, drizzleFileAccess(db));
    await expect(
      reader.readDetails({
        threadId: THREAD_ID,
        trailId,
        userId: "00000000-0000-4000-8000-000000000812" as never,
      }),
    ).resolves.toEqual([]);

    const revokedAccess = { historyAccess: async () => null };
    await expect(
      createDrizzleChangeTrailReader(db, revokedAccess).readDetails({
        threadId: THREAD_ID,
        trailId,
        userId: USER_ID,
      }),
    ).resolves.toEqual([]);
  });

  it("settles a terminal turn while its unapplied writes stay in the draft", async () => {
    const harness = createHarness(db);
    await harness.seedDestructivePush("unpushed-settlement");

    await harness.pollTrails();
    expect(await harness.trailRowMembership()).toMatchObject({
      shells: [expect.objectContaining({ state: "settling", version: 2 })],
      details: [],
    });
    expect(await harness.trailEventSequence()).toEqual([
      expect.objectContaining({ eventKind: "updated", version: 2 }),
    ]);

    await harness.pollTrails();
    expect(await harness.trailRowMembership()).toMatchObject({
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
    });
    expect(await harness.trailEventSequence()).toEqual([
      expect.objectContaining({ eventKind: "updated", version: 2 }),
      expect.objectContaining({ eventKind: "settled", version: 3 }),
    ]);
  });

  it.each([
    "complete",
    "cancelled",
    "error",
  ])("settles an empty %s turn after restart", async (status) => {
    await db.transaction(async (tx) => {
      await invalidateTrailOwners(tx, { turnIds: [TURN_ID] });
      await tx.update(schema.turns).set({ status }).where(eq(schema.turns.id, TURN_ID));
    });
    const coldDb = createTestDatabase();
    try {
      const cold = createDrizzleChangeTrailAggregateWriter(coldDb);
      await cold.reconcileTerminalOwners();
      await cold.reconcileTerminalOwners();
      const [shell] = await coldDb.select().from(schema.changeTrailShells);
      const [turn] = await coldDb.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID));
      expect(shell).toMatchObject({
        state: "settled",
        changeCount: 0,
        documentCount: 0,
        reconciledRevision: turn.trailDirtyRevision,
      });
    } finally {
      await closeDatabase(coldDb);
    }
  });

  it("recovers a late Discard committed before the trail worker restarts", async () => {
    const warm = createHarness(db);
    try {
      const branchId = await warm.seedDestructivePush("late-discard-restart");
      await warm.pollTrails();
      await warm.pollTrails();
      const [settled] = (await warm.trailRowMembership()).shells;
      await warm.crossWorkProbeFixture().collab.draftReview.discardWorkDraft({
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: branchId,
        userId: USER_ID,
      });
      const [owner] = await db.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID));
      expect(owner.trailDirtyRevision).toBeGreaterThan(settled.reconciledRevision);
      warm.destroyWarmState();
      const coldDb = createTestDatabase();
      try {
        const cold = createDrizzleChangeTrailAggregateWriter(coldDb);
        await cold.reconcileTerminalOwners();
        await cold.reconcileTerminalOwners();
        const [shell] = await coldDb.select().from(schema.changeTrailShells);
        expect(shell).toMatchObject({
          state: "settled",
          version: settled.version + 3,
          reconciledRevision: owner.trailDirtyRevision,
        });
      } finally {
        await closeDatabase(coldDb);
      }
    } finally {
      warm.destroyWarmState();
    }
  });

  it("commits receipt and placement invalidation atomically, then recovers without a warm owner", async () => {
    const revision = async () =>
      (await db.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID)))[0]
        .trailDirtyRevision;
    const initial = await revision();
    const receipt = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      await invalidateTrailOwners(tx, { owners: [{ threadId: THREAD_ID, turnId: TURN_ID }] });
      const [edit] = await tx
        .insert(schema.documentEdits)
        .values({
          documentId: ALPHA_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          actor: "agent",
          kind: "write",
        })
        .returning();
      await tx.insert(schema.documentEditParts).values({
        editId: edit.id,
        ordinal: 0,
        update: Buffer.from([0, 0]),
        effect: { inserted: [], deleted: [] },
        frontier: {},
        origin: { kind: "live", seq: 1 },
        placement: { kind: "live", seq: 1 },
      });
      return edit.id;
    };
    await expect(
      db.transaction(async (tx) => {
        await receipt(tx);
        throw new Error("receipt rollback");
      }),
    ).rejects.toThrow("receipt rollback");
    expect(await revision()).toBe(initial);
    expect(await db.select().from(schema.documentEdits)).toEqual([]);
    const id = await db.transaction(receipt);
    const admitted = await revision();
    expect(admitted).toBeGreaterThan(initial);
    await db.transaction(async (tx) => {
      await invalidateTrailOwners(tx, { editIds: [id] });
      await tx
        .update(schema.documentEditParts)
        .set({ placement: { kind: "discarded" } })
        .where(eq(schema.documentEditParts.editId, id));
    });
    const placed = await revision();
    expect(placed).toBeGreaterThan(admitted);
    const coldDb = createTestDatabase();
    try {
      const cold = createDrizzleChangeTrailAggregateWriter(coldDb);
      await cold.reconcileTerminalOwners();
      await cold.reconcileTerminalOwners();
      expect(await coldDb.select().from(schema.changeTrailShells)).toEqual([
        expect.objectContaining({ state: "settled", reconciledRevision: placed }),
      ]);
    } finally {
      await closeDatabase(coldDb);
    }
  });

  it("does not synthesize a shared trail from mixed journal ownership", async () => {
    const harness = createHarness(db);
    const branchId = await harness.seedDestructivePush("shared-settlement");
    await harness.makeJournalOwnershipMixed();
    await expect(harness.push(branchId)).resolves.toMatchObject({ status: "pushed" });

    await harness.pollTrails();
    await harness.pollTrails();

    const rows = await harness.trailRowMembership();
    expect(rows.shells).toEqual([
      expect.objectContaining({
        ownerKind: "turn",
        state: "settled",
        settledAt: expect.any(Date),
      }),
    ]);
    for (const shell of rows.shells) {
      expect(
        rows.outbox
          .filter((row) => row.trailId === shell.id)
          .map((row) => [row.version, row.eventKind]),
      ).toEqual(expect.arrayContaining([[shell.version, "settled"]]));
    }
  });

  it("serializes concurrent per-document trail versions without losing either push", async () => {
    const harness = createHarness(db);
    const alpha = await harness.seedDestructivePush("version-race-alpha", ALPHA_ID);
    const beta = await harness.seedDestructivePush("version-race-beta", BETA_ID);

    await expect(Promise.all([harness.push(alpha), harness.push(beta)])).resolves.toEqual([
      expect.objectContaining({ status: "pushed" }),
      expect.objectContaining({ status: "pushed" }),
    ]);
    const rows = await harness.trailRowMembership();
    expect(rows.shells).toEqual([expect.objectContaining({ version: 2, documentCount: 2 })]);
    expect(rows.details.map((row) => row.documentId).sort()).toEqual([ALPHA_ID, BETA_ID]);
    expect(rows.outbox.map((row) => row.version).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(
      new Set(rows.outbox.map((row) => `${row.trailId}:${row.version}:${row.eventKind}`)).size,
    ).toBe(rows.outbox.length);
    expect(await harness.pushRows()).toHaveLength(2);
  });

  it("serializes shared recording against terminal reconciliation", async () => {
    const harness = createHarness(db);
    const first = await harness.seedDestructivePush("shared-record-reconcile-first", ALPHA_ID);
    await harness.makeJournalOwnershipNull();
    await harness.push(first);
    await harness.pollTrails();

    const second = await harness.seedDestructivePush("shared-record-reconcile-second", BETA_ID);
    await harness.makeJournalOwnershipNull();
    await expect(Promise.all([harness.push(second), harness.pollTrails()])).resolves.toEqual([
      expect.objectContaining({ status: "pushed" }),
      expect.any(Number),
    ]);

    const rows = await harness.trailRowMembership();
    const shared = rows.shells.find((shell) => shell.ownerKind === "shared");
    expect(shared).toMatchObject({ documentCount: 2 });
    const sharedEvents = rows.outbox.filter((row) => row.trailId === shared?.id);
    expect(new Set(sharedEvents.map((row) => `${row.version}:${row.eventKind}`)).size).toBe(
      sharedEvents.length,
    );
  });

  it("uses one sorted lock order for combined shared and turn reconciliation", async () => {
    const harness = createHarness(db);
    const branchId = await harness.seedDestructivePush("combined-lock-order");
    await harness.makeJournalOwnershipMixed();
    await harness.push(branchId);
    await harness.stageAnotherDestructiveEdit(branchId);
    await harness.makeJournalOwnershipMixed();

    await expect(
      Promise.race([
        Promise.all([harness.push(branchId), harness.pollTrails()]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("aggregate lock-order deadlock")), 5_000),
        ),
      ]),
    ).resolves.toEqual([expect.objectContaining({ status: "pushed" }), expect.any(Number)]);
  });

  it("reopens and re-settles a settled trail when branch work is redone", async () => {
    const harness = createHarness(db);
    const branchId = await harness.seedDestructivePush("redo-after-settled");

    await harness.pollTrails();
    await harness.pollTrails();
    const [settled] = (await harness.trailRowMembership()).shells;
    expect(settled).toMatchObject({
      state: "settled",
      version: 3,
      settledAt: expect.any(Date),
      changeCount: 0,
      documentCount: 0,
    });

    await expect(harness.reverseTurn("undo")).resolves.toMatchObject({ status: "reversed" });
    await expect(harness.reverseTurn("redo")).resolves.toMatchObject({ status: "reconciled" });

    const reopened = await harness.trailRowMembership();
    expect(reopened.shells).toEqual([
      expect.objectContaining({ state: "building", version: 4, settledAt: null }),
    ]);
    expect((await harness.trailEventSequence()).map((row) => [row.version, row.eventKind])).toEqual(
      [
        [2, "updated"],
        [3, "settled"],
        [4, "updated"],
      ],
    );

    // The redo waits in the draft (D59); Apply records its publication.
    await expect(harness.push(branchId)).resolves.toMatchObject({ status: "pushed" });
    await harness.pollTrails();
    expect((await harness.trailRowMembership()).shells).toEqual([
      expect.objectContaining({ state: "settling", version: 6, settledAt: null }),
    ]);

    await harness.pollTrails();
    const resettled = await harness.trailRowMembership();
    expect(resettled.shells).toEqual([
      expect.objectContaining({
        state: "settled",
        version: 7,
        settledAt: expect.any(Date),
        changeCount: 1,
        documentCount: 1,
      }),
    ]);
    expect((await harness.trailEventSequence()).map((row) => [row.version, row.eventKind])).toEqual(
      [
        [2, "updated"],
        [3, "settled"],
        [4, "updated"],
        [5, "updated"],
        [6, "updated"],
        [7, "settled"],
      ],
    );
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
});
