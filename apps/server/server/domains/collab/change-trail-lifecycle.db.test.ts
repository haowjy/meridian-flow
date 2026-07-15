import { createAgentEditCodec, toDocHandle, yProsemirrorModel } from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDrizzleDocumentAccess } from "../../lib/document-access.js";
import { createDrizzleChangeTrailReader } from "./adapters/drizzle-change-trail-reader.js";
import { createDrizzleTrailForwardActions } from "./adapters/drizzle-trail-forward-actions.js";
import {
  createInMemoryCoordinator,
  createInMemoryJournal,
} from "./adapters/in-memory/agent-edit.js";
import { deletionBoundaryTarget } from "./domain/trail-read-kernel.js";
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

  it("restores captured prose journal-first against a live document and deduplicates retries", async () => {
    const documentSchema = buildDocumentSchema();
    const codec = createAgentEditCodec(mdxCodec({ schema: documentSchema }));
    const model = yProsemirrorModel(documentSchema);
    const coordinator = createInMemoryCoordinator(createInMemoryJournal());
    const liveDoc = coordinator.ensureEmpty(ALPHA_ID);
    model.insertBlocks(toDocHandle(liveDoc), null, codec.parse("Surviving prose."));
    const nextBlock = liveDoc.getXmlFragment("prosemirror").get(0);
    if (!(nextBlock instanceof Y.XmlElement)) {
      throw new Error("missing live anchor block");
    }
    const trailId = "00000000-0000-4000-8000-000000000809";
    const changeId = "restore-change";
    await db.insert(schema.changeTrailShells).values({
      id: trailId,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      ownerKind: "turn",
      changeCount: 1,
      sweptChangeCount: 1,
      documentCount: 1,
    });
    await db.insert(schema.changeTrailDocumentDetails).values({
      trailId,
      documentId: ALPHA_ID,
      documentTitle: "Alpha",
      changes: [
        {
          changeId,
          ordinal: 0,
          documentId: ALPHA_ID,
          pushId: null,
          receiptId: "receipt-1",
          kind: "delete",
          beforeBlockId: "deleted-block",
          afterBlockId: null,
          beforeText: "deleted-block|Restored prose.",
          afterTextAtReceipt: null,
          navigation: deletionBoundaryTarget({ doc: liveDoc, next: nextBlock }),
          swept: {
            affectedBlockHash: "deleted-block",
            removed: { status: "available", markdown: "Restored prose." },
            beforeContentRef: null,
          },
          writerProtection: {
            kind: "sweep",
            body: { status: "available", markdown: "Restored prose." },
          },
          reversible: false,
        },
      ],
    });
    const actions = createDrizzleTrailForwardActions({ db, coordinator, model, codec });
    const request = {
      threadId: THREAD_ID,
      trailId,
      changeId,
      action: "restore" as const,
      userId: USER_ID,
    };

    await expect(actions.apply(request)).resolves.toEqual({ status: "applied" });
    await expect(actions.apply(request)).resolves.toEqual({ status: "already_applied" });
    expect(codec.serialize(model.projectBlocks(toDocHandle(liveDoc)))).toContain("Restored prose.");
    const journalRows = await db
      .select()
      .from(schema.documentYjsUpdates)
      .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID));
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0]?.originType).toBe("human");
  });

  it("retains captured trail prose after the file is permanently deleted", async () => {
    const trailId = "00000000-0000-4000-8000-000000000810";
    await db.insert(schema.changeTrailShells).values({
      id: trailId,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      ownerKind: "turn",
      changeCount: 1,
      sweptChangeCount: 1,
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
          beforeBlockId: "deleted-block",
          afterBlockId: null,
          beforeText: "deleted-block|Captured after reload.",
          afterTextAtReceipt: null,
          navigation: { kind: "unavailable", reason: "document_deleted" },
          swept: null,
          reversible: false,
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
        unavailable: true,
        changes: [
          expect.objectContaining({
            beforeText: "deleted-block|Captured after reload.",
          }),
        ],
      }),
    ]);
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
          sweptChangeCount: 0,
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

    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await expect(harness.pollTrails()).resolves.toEqual(expect.any(Number));
    expect(await harness.workRows()).toEqual([
      expect.objectContaining({ state: "complete", attempts: 2 }),
    ]);
    expect(await harness.branchGeneration(branchId)).toBe(2);

    await harness.stageAnotherDestructiveEdit(branchId);
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    expect(await harness.branchGeneration(branchId)).toBe(3);
  });

  it("fences exhausted auto-push work without falsely settling its trail", async () => {
    const harness = createHarness();
    await harness.seedDestructivePush("exhausted-auto-push");
    await harness.setPushPolicy("auto");
    harness.failAllTrailRetries();

    for (const delay of [0, 2_100, 4_100, 8_100, 16_100]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
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
  }, 40_000);

  it("settles shared and per-turn trails from their respective durable work rows", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("shared-settlement");
    await harness.makeJournalOwnershipMixed();
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });

    await harness.pollTrails();
    await harness.pollTrails();

    const rows = await harness.trailRows();
    expect(rows.shells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: "shared",
          state: "settled",
          settledAt: expect.any(Date),
        }),
        expect.objectContaining({
          ownerKind: "turn",
          state: "settled",
          settledAt: expect.any(Date),
        }),
      ]),
    );
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
    await harness.makeJournalOwnershipMixed();
    await harness.autoPush(first);
    await harness.pollTrails();

    const second = await harness.seedDestructivePush("shared-record-reconcile-second", BETA_ID);
    await harness.makeJournalOwnershipMixed();
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
      sweptChangeCount: 0,
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
        sweptChangeCount: 1,
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
          sweptChangeCount: 1,
          documentCount: 1,
        }),
      ],
      details: [expect.objectContaining({ changes: [expect.any(Object)] })],
    });
  });
});
