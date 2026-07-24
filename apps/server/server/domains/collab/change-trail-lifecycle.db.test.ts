import {
  createAgentEditCodec,
  toDocHandle,
  toRef,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDrizzleDocumentAccess } from "../../lib/document-access.js";
import { createDrizzleChangeTrailReader } from "./adapters/drizzle-change-trail-reader.js";
import {
  createDrizzleTrailForwardActions,
  liveStateFingerprint,
} from "./adapters/drizzle-trail-forward-actions.js";
import {
  createInMemoryCoordinator,
  createInMemoryJournal,
} from "./adapters/in-memory/agent-edit.js";
import { deletionBoundaryTarget, liveBlockTarget } from "./domain/trail-read-kernel.js";
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

function durableProjectionSerializer(
  model: ReturnType<typeof yProsemirrorModel>,
  codec: ReturnType<typeof createAgentEditCodec>,
) {
  return {
    async serializeDocument(_documentId: string, doc: Y.Doc) {
      return codec.serialize(model.projectBlocks(toDocHandle(doc)));
    },
  };
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
        sweptChangeCount: 2,
      }),
    ]);
    expect(trails.details).toHaveLength(2);
    expect(
      trails.details.flatMap((detail) =>
        (
          detail.changes as Array<{
            writerProtection?: { kind: string; body: { markdown: string } };
          }>
        ).flatMap((change) =>
          change.writerProtection?.kind === "sweep" ? [change.writerProtection.body.markdown] : [],
        ),
      ),
    ).toEqual([
      expect.stringContaining("Writer captured body"),
      expect.stringContaining("Writer captured body"),
    ]);
    cold.destroyWarmState();
  });

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
    const actions = createDrizzleTrailForwardActions({
      db,
      documentAccess: createDrizzleDocumentAccess(db),
      coordinator,
      model,
      codec,
      durableProjectionSerializer: durableProjectionSerializer(model, codec),
    });
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

  it("does not apply a committed forward action after document access is revoked", async () => {
    const documentSchema = buildDocumentSchema();
    const codec = createAgentEditCodec(mdxCodec({ schema: documentSchema }));
    const model = yProsemirrorModel(documentSchema);
    const coordinator = createInMemoryCoordinator(createInMemoryJournal());
    const liveDoc = coordinator.ensureEmpty(ALPHA_ID);
    model.insertBlocks(toDocHandle(liveDoc), null, codec.parse("Surviving prose."));
    const nextBlock = liveDoc.getXmlFragment("prosemirror").get(0);
    if (!(nextBlock instanceof Y.XmlElement)) throw new Error("missing live anchor block");
    const trailId = "00000000-0000-4000-8000-000000000812";
    const changeId = "revoked-restore";
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
          receiptId: "receipt-revoked",
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
    let accessLocks = 0;
    const actions = createDrizzleTrailForwardActions({
      db,
      documentAccess: {
        lockDocumentAccessState: async () => {
          accessLocks += 1;
          return accessLocks < 3 ? "available" : null;
        },
      },
      coordinator,
      model,
      codec,
      durableProjectionSerializer: durableProjectionSerializer(model, codec),
    });

    await expect(
      actions.apply({
        threadId: THREAD_ID,
        trailId,
        changeId,
        action: "restore",
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "anchor_unavailable" });
    expect(codec.serialize(model.projectBlocks(toDocHandle(liveDoc))).trim()).toBe(
      "Surviving prose.",
    );
    expect(
      await db
        .select()
        .from(schema.documentYjsUpdates)
        .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID)),
    ).toEqual([]);
  });

  it("recovers a committed forward action after a crash before live apply", async () => {
    const documentSchema = buildDocumentSchema();
    const codec = createAgentEditCodec(mdxCodec({ schema: documentSchema }));
    const model = yProsemirrorModel(documentSchema);
    const coordinator = createInMemoryCoordinator(createInMemoryJournal());
    const liveDoc = coordinator.ensureEmpty(ALPHA_ID);
    model.insertBlocks(toDocHandle(liveDoc), null, codec.parse("Surviving prose."));
    const scratch = new Y.Doc({ gc: false });
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(liveDoc));
    const before = Y.encodeStateVector(scratch);
    model.insertBlocks(toDocHandle(scratch), null, codec.parse("Recovered once."));
    const committedUpdate = Y.encodeStateAsUpdate(scratch, before);
    scratch.destroy();

    const expectedLiveStateHash = liveStateFingerprint(liveDoc);
    const trailId = "00000000-0000-4000-8000-000000000811";
    const changeId = "crashed-restore";
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
          receiptId: null,
          kind: "delete",
          beforeBlockId: "deleted-block",
          afterBlockId: null,
          beforeText: "deleted-block|Recovered once.",
          afterTextAtReceipt: null,
          navigation: { kind: "unavailable", reason: "crash_fixture" },
          swept: null,
          writerProtection: {
            kind: "sweep",
            body: { status: "available", markdown: "Recovered once." },
          },
          forwardActions: {
            restore: {
              status: "committed",
              update: Buffer.from(committedUpdate).toString("base64"),
              expectedLiveStateHash,
            },
          },
          reversible: false,
        },
      ],
    });
    const actions = createDrizzleTrailForwardActions({
      db,
      documentAccess: createDrizzleDocumentAccess(db),
      coordinator,
      model,
      codec,
      durableProjectionSerializer: durableProjectionSerializer(model, codec),
    });
    const request = {
      threadId: THREAD_ID,
      trailId,
      changeId,
      action: "restore" as const,
      userId: USER_ID,
    };

    await expect(actions.apply(request)).resolves.toEqual({ status: "applied" });
    await expect(actions.apply(request)).resolves.toEqual({ status: "already_applied" });
    const markdown = codec.serialize(model.projectBlocks(toDocHandle(liveDoc)));
    expect(markdown.match(/Recovered once\./g)).toHaveLength(1);
  });

  it("durably settles retry exhaustion after three live-state collisions", async () => {
    const documentSchema = buildDocumentSchema();
    const codec = createAgentEditCodec(mdxCodec({ schema: documentSchema }));
    const model = yProsemirrorModel(documentSchema);
    const coordinator = createInMemoryCoordinator(createInMemoryJournal());
    const liveDoc = coordinator.ensureEmpty(ALPHA_ID);
    model.insertBlocks(toDocHandle(liveDoc), null, codec.parse("Surviving prose."));
    const nextBlock = liveDoc.getXmlFragment("prosemirror").get(0);
    if (!(nextBlock instanceof Y.XmlElement)) throw new Error("missing live anchor block");

    const trailId = "00000000-0000-4000-8000-000000000813";
    const changeId = "retry-exhausted-restore";
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
          receiptId: null,
          kind: "delete",
          beforeBlockId: "deleted-block",
          afterBlockId: null,
          beforeText: "deleted-block|Never restored.",
          afterTextAtReceipt: null,
          navigation: deletionBoundaryTarget({ doc: liveDoc, next: nextBlock }),
          swept: null,
          writerProtection: {
            kind: "sweep",
            body: { status: "available", markdown: "Never restored." },
          },
          reversible: false,
        },
      ],
    });

    const documentAccess = createDrizzleDocumentAccess(db);
    let accessLockCount = 0;
    const actions = createDrizzleTrailForwardActions({
      db,
      documentAccess: {
        async lockDocumentAccessState(tx, userId, documentId) {
          accessLockCount += 1;
          if (accessLockCount > 1 && accessLockCount % 2 === 1) {
            model.insertBlocks(
              toDocHandle(liveDoc),
              null,
              codec.parse(`Writer collision ${(accessLockCount - 1) / 2}.`),
            );
          }
          return documentAccess.lockDocumentAccessState(tx, userId, documentId);
        },
      },
      coordinator,
      model,
      codec,
      durableProjectionSerializer: durableProjectionSerializer(model, codec),
    });

    await expect(
      actions.apply({
        threadId: THREAD_ID,
        trailId,
        changeId,
        action: "restore",
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "retry_exhausted" });
    const [detail] = await db
      .select({ changes: schema.changeTrailDocumentDetails.changes })
      .from(schema.changeTrailDocumentDetails)
      .where(eq(schema.changeTrailDocumentDetails.trailId, trailId));
    expect(detail?.changes).toEqual([
      expect.objectContaining({
        changeId,
        forwardActions: {
          restore: { status: "settled", outcome: "retry_exhausted" },
        },
      }),
    ]);
    expect(await db.select().from(schema.documentYjsUpdates)).toHaveLength(0);
  });

  it("keeps concurrent writer prose when a committed Delete-again guard rejects", async () => {
    const documentSchema = buildDocumentSchema();
    const codec = createAgentEditCodec(mdxCodec({ schema: documentSchema }));
    const model = yProsemirrorModel(documentSchema);
    const coordinator = createInMemoryCoordinator(createInMemoryJournal());
    const liveDoc = coordinator.ensureEmpty(ALPHA_ID);
    model.insertBlocks(toDocHandle(liveDoc), null, codec.parse("Restored prose.\n\nSurvivor."));
    const doomed = liveDoc.getXmlFragment("prosemirror").get(0);
    if (!(doomed instanceof Y.XmlElement)) throw new Error("missing restored block");

    const trailId = "00000000-0000-4000-8000-000000000812";
    const changeId = "delete-again-collision";
    await db.insert(schema.changeTrailShells).values({
      id: trailId,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      ownerKind: "turn",
      changeCount: 1,
      sweptChangeCount: 0,
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
          receiptId: null,
          kind: "insert",
          beforeBlockId: null,
          afterBlockId: "restored-block",
          beforeText: null,
          afterTextAtReceipt: "restored-block|Restored prose.",
          navigation: liveBlockTarget(liveDoc, doomed),
          swept: null,
          writerProtection: {
            kind: "resurrection",
            body: { status: "available", markdown: "Restored prose." },
          },
          reversible: false,
        },
      ],
    });

    let transactionCount = 0;
    const collisionDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async (...args: Parameters<typeof db.transaction>) => {
            const result = await target.transaction(...args);
            transactionCount += 1;
            if (transactionCount === 1) {
              model.deleteBlock(toDocHandle(liveDoc), toRef(doomed));
              model.insertBlocks(
                toDocHandle(liveDoc),
                null,
                codec.parse("Concurrent writer words."),
              );
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const actions = createDrizzleTrailForwardActions({
      db: collisionDb,
      documentAccess: createDrizzleDocumentAccess(db),
      coordinator,
      model,
      codec,
      durableProjectionSerializer: durableProjectionSerializer(model, codec),
    });

    await expect(
      actions.apply({
        threadId: THREAD_ID,
        trailId,
        changeId,
        action: "delete-again",
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "anchor_unavailable" });
    const markdown = codec.serialize(model.projectBlocks(toDocHandle(liveDoc)));
    expect(markdown).toContain("Concurrent writer words.");
    expect(markdown).toContain("Survivor.");
    expect(await db.select().from(schema.documentYjsUpdates)).toHaveLength(0);
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
    const documentSchema = buildDocumentSchema();
    const codec = createAgentEditCodec(mdxCodec({ schema: documentSchema }));
    const model = yProsemirrorModel(documentSchema);
    const coordinator = createInMemoryCoordinator(createInMemoryJournal());
    const liveDoc = coordinator.ensureEmpty(ALPHA_ID);
    model.insertBlocks(toDocHandle(liveDoc), null, codec.parse("Surviving prose."));
    const nextBlock = liveDoc.getXmlFragment("prosemirror").get(0);
    if (!(nextBlock instanceof Y.XmlElement)) throw new Error("missing live anchor block");
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
      documentTitle: "Protected chapter",
      changes: [
        {
          changeId: "protected-change",
          ordinal: 0,
          documentId: ALPHA_ID,
          pushId: null,
          receiptId: null,
          kind: "delete",
          beforeBlockId: "protected-block",
          afterBlockId: null,
          beforeText: "protected-block|Protected prose.",
          afterTextAtReceipt: null,
          navigation: deletionBoundaryTarget({ doc: liveDoc, next: nextBlock }),
          swept: null,
          writerProtection: {
            kind: "sweep",
            body: { status: "available", markdown: "Protected prose." },
          },
          reversible: false,
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

    const actions = createDrizzleTrailForwardActions({
      db,
      documentAccess: createDrizzleDocumentAccess(db),
      coordinator,
      model,
      codec,
      durableProjectionSerializer: durableProjectionSerializer(model, codec),
    });
    await expect(
      actions.apply({
        threadId: THREAD_ID,
        trailId,
        changeId: "protected-change",
        action: "restore",
        userId: "00000000-0000-4000-8000-000000000812",
      }),
    ).resolves.toEqual({ status: "anchor_unavailable" });
    expect(codec.serialize(model.projectBlocks(toDocHandle(liveDoc))).trim()).toBe(
      "Surviving prose.",
    );
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
