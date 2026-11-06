/**
 * Database coverage for change trail lifecycle.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - cold terminal-owner reconciliation and transaction-bound receipt invalidation
 */

import {
  createAgentEditCodecFactory,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { drizzleFileAccess, grantedJournal } from "../../test-support/file-grants.js";
import {
  createDrizzleChangeTrailAggregateWriter,
  trailIdForOwner,
} from "./adapters/drizzle-change-trail-aggregate.js";
import { createDrizzleChangeTrailReader } from "./adapters/drizzle-change-trail-reader.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createStaticDocumentLinkScopes } from "./adapters/in-memory/static-document-link-scopes.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
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
  const db = createTestDatabase();
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeDatabase(db));
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

  it.each([
    "complete",
    "cancelled",
    "error",
  ])("settles an empty %s turn after restart", async (status) => {
    await db.update(schema.turns).set({ status }).where(eq(schema.turns.id, TURN_ID));
    const coldDb = createTestDatabase();
    try {
      const cold = createDrizzleChangeTrailAggregateWriter(coldDb);
      await cold.reconcileTerminalOwners();
      await cold.reconcileTerminalOwners();
      const [shell] = await coldDb.select().from(schema.changeTrailShells);
      expect(shell).toMatchObject({
        state: "settled",
        changeCount: 0,
        documentCount: 0,
      });
    } finally {
      await closeDatabase(coldDb);
    }
  });

  it("commits receipt invalidation atomically, then recovers without a warm owner", async () => {
    const revision = async () => (await db.select().from(schema.changeTrailDirtyLog)).length;
    const initial = await revision();
    const receipt = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
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
    await db.transaction(receipt);
    expect(await revision()).toBeGreaterThan(initial);
    const coldDb = createTestDatabase();
    try {
      const cold = createDrizzleChangeTrailAggregateWriter(coldDb);
      await cold.reconcileTerminalOwners();
      await cold.reconcileTerminalOwners();
      expect(await coldDb.select().from(schema.changeTrailShells)).toEqual([
        expect.objectContaining({ state: "settled" }),
      ]);
    } finally {
      await closeDatabase(coldDb);
    }
  });

  async function writeLiveReplacement(
    input: { threadId?: ThreadId; turnId?: TurnId | null; responseId?: string } = {},
  ) {
    const threadId = input.threadId ?? THREAD_ID;
    const turnId = input.turnId === undefined ? TURN_ID : input.turnId;
    const persistence = createDrizzleCollabPersistence(db);
    const documentSchema = buildDocumentSchema();
    const codec = createAgentEditCodecFactory(mdxCodec({ schema: documentSchema }));
    const model = yProsemirrorModel(documentSchema);
    const doc = createCollabYDoc({ gc: false });
    try {
      model.insertBlocks(toDocHandle(doc), null, codec.parse("Alpha base."));
      await persistence.seeds.seedInitialDocument(ALPHA_ID, Y.encodeStateAsUpdate(doc));
      const block = model.getBlocks(toDocHandle(doc))[0];
      if (!block) throw new Error("live test document has no block");
      const beforeUpdate = Y.encodeStateVector(doc);
      model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 5 }, "Gamma");
      const update = Y.encodeStateAsUpdate(doc, beforeUpdate);
      await grantedJournal(persistence.journal).appendBatch([
        {
          docId: ALPHA_ID,
          update,
          meta: {
            origin: turnId ? `agent:${turnId}` : "system",
            ...(turnId ? { actorTurnId: turnId } : {}),
            seq: 0,
          },
          mutation: {
            mode: "live",
            actorKind: "agent",
            threadId,
            turnId,
            wId: await persistence.journal.reserveWriteOrdinal(ALPHA_ID, threadId),
            ...(input.responseId
              ? { authoringResponseId: input.responseId, editScopeId: input.responseId }
              : {}),
            writeId: "live-write",
            editParts: [update],
          },
        },
      ]);
    } finally {
      doc.destroy();
    }
    return persistence;
  }

  const ownerTrailId = trailIdForOwner({ kind: "turn", threadId: THREAD_ID, turnId: TURN_ID });
  const projector = () =>
    createDrizzleChangeTrailAggregateWriter(db, createStaticDocumentLinkScopes());
  async function reconcile(trail: ReturnType<typeof projector>) {
    await trail.reconcileTerminalOwners();
    await trail.reconcileTerminalOwners();
  }
  async function readTrail(trailId = ownerTrailId) {
    const [shell] = await db
      .select()
      .from(schema.changeTrailShells)
      .where(eq(schema.changeTrailShells.id, trailId));
    const details = await db
      .select()
      .from(schema.changeTrailDocumentDetails)
      .where(eq(schema.changeTrailDocumentDetails.trailId, trailId));
    const occurrences = await db
      .select()
      .from(schema.changeTrailDocumentOccurrences)
      .where(eq(schema.changeTrailDocumentOccurrences.trailId, trailId));
    return { shell, details, occurrences };
  }

  it("recovers a direct live agent write into a nonempty settled trail after restart", async () => {
    await writeLiveReplacement();
    expect(await db.select().from(schema.changeTrailDocumentDetails)).toEqual([]);
    const trail = projector();
    await reconcile(trail);
    const { shell, details, occurrences } = await readTrail();
    expect(shell).toMatchObject({ state: "settled", changeCount: 1, documentCount: 1 });
    expect(details).toEqual([
      expect.objectContaining({
        documentId: ALPHA_ID,
        changes: [
          expect.objectContaining({
            kind: "modify",
            beforeText: expect.stringContaining("Alpha base."),
            afterTextAtReceipt: expect.stringContaining("Gamma base."),
          }),
        ],
      }),
    ]);
    expect(occurrences).toEqual([
      expect.objectContaining({ documentId: ALPHA_ID, projectionRevision: 1 }),
    ]);
  });

  it("attributes a nested subagent write to the nearest primary conversation's spawning turn", async () => {
    const childThread = crypto.randomUUID() as ThreadId;
    const nestedThread = crypto.randomUUID() as ThreadId;
    const childTurn = crypto.randomUUID() as TurnId;
    const nestedTurn = crypto.randomUUID() as TurnId;
    await db.insert(schema.threads).values([
      {
        id: childThread,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        rootThreadId: THREAD_ID,
        parentThreadId: THREAD_ID,
        originTurnId: TURN_ID,
        kind: "subagent",
        originType: "spawn",
        spawnStatus: "succeeded",
        title: "Child",
      },
      {
        id: nestedThread,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        rootThreadId: THREAD_ID,
        parentThreadId: childThread,
        originTurnId: TURN_ID,
        kind: "subagent",
        originType: "spawn",
        spawnStatus: "succeeded",
        title: "Nested child",
      },
    ]);
    await db.insert(schema.turns).values([
      {
        id: childTurn,
        threadId: childThread,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      },
      {
        id: nestedTurn,
        threadId: nestedThread,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      },
    ]);
    await db.insert(schema.threadExecutionReports).values([
      {
        executionTurnId: childTurn,
        childThreadId: childThread,
        handle: "p1",
        origin: "spawn",
        deliveryMode: "background_notification",
        callerThreadId: THREAD_ID,
        callerTurnId: TURN_ID,
      },
      {
        executionTurnId: nestedTurn,
        childThreadId: nestedThread,
        handle: "p2",
        origin: "spawn",
        deliveryMode: "background_notification",
        callerThreadId: childThread,
        callerTurnId: childTurn,
      },
    ]);
    await writeLiveReplacement({ threadId: nestedThread, turnId: nestedTurn });
    await reconcile(projector());
    expect((await readTrail()).shell).toMatchObject({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      state: "settled",
      changeCount: 1,
      documentCount: 1,
    });
    expect((await readTrail()).details[0]?.changes).toEqual([
      expect.objectContaining({
        beforeText: expect.stringContaining("Alpha base."),
        afterTextAtReceipt: expect.stringContaining("Gamma base."),
      }),
    ]);
    const misplaced = await db
      .select()
      .from(schema.changeTrailDocumentDetails)
      .where(
        eq(
          schema.changeTrailDocumentDetails.trailId,
          trailIdForOwner({ kind: "turn", threadId: nestedThread, turnId: nestedTurn }),
        ),
      );
    expect(misplaced).toEqual([]);
  });

  it("keeps an agent write without a turn in the conversation's shared trail", async () => {
    await writeLiveReplacement({ turnId: null });
    await reconcile(projector());
    const sharedId = trailIdForOwner({ kind: "shared", threadId: THREAD_ID, turnId: null });
    const { shell, details, occurrences } = await readTrail(sharedId);
    expect(shell).toMatchObject({
      ownerKind: "shared",
      turnId: null,
      state: "settled",
      changeCount: 1,
      documentCount: 1,
    });
    expect(details[0]?.changes).toEqual([
      expect.objectContaining({ afterTextAtReceipt: expect.stringContaining("Gamma base.") }),
    ]);
    expect(occurrences).toHaveLength(1);
  });

  it("clears the live trail on card Undo and restores its truthful effect on Redo", async () => {
    await writeLiveReplacement();
    const harness = createHarness(db);
    const view = harness.crossWorkProbeFixture();
    const trail = projector();
    try {
      await reconcile(trail);
      const before = await readTrail();
      expect(before.shell).toMatchObject({ changeCount: 1, documentCount: 1 });
      expect(
        await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        }),
      ).toMatchObject({ status: "reversed" });
      await reconcile(trail);
      const undone = await readTrail();
      expect(undone.shell).toMatchObject({
        state: "settled",
        changeCount: 0,
        documentCount: 0,
        wordsAdded: 0,
        wordsRemoved: 0,
      });
      expect(undone.details).toEqual([]);
      expect(undone.occurrences[0]?.projectionRevision).toBeGreaterThan(
        before.occurrences[0]?.projectionRevision ?? 0,
      );
      expect(
        await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction: "redo",
          actor: { type: "user", userId: USER_ID },
        }),
      ).toMatchObject({ status: "reversed" });
      await reconcile(trail);
      const redone = await readTrail();
      expect(redone.shell).toMatchObject({ state: "settled", changeCount: 1, documentCount: 1 });
      expect(redone.details[0]?.changes).toEqual([
        expect.objectContaining({
          beforeText: expect.stringContaining("Alpha base."),
          afterTextAtReceipt: expect.stringContaining("Gamma base."),
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("clears a failed response's live trail after its durable rollback", async () => {
    const responseId = crypto.randomUUID();
    await db.insert(schema.modelResponses).values({
      id: responseId as never,
      turnId: TURN_ID,
      sequence: 1,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    await writeLiveReplacement({ responseId });
    const harness = createHarness(db);
    const trail = projector();
    try {
      await reconcile(trail);
      expect((await readTrail()).shell).toMatchObject({ changeCount: 1 });
      await harness.rollbackResponse(responseId);
      await reconcile(trail);
      const rolledBack = await readTrail();
      expect(rolledBack.shell).toMatchObject({
        state: "settled",
        changeCount: 0,
        documentCount: 0,
      });
      expect(rolledBack.details).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});
