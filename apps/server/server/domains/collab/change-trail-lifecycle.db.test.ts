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
import { createLiveTrailProjector } from "./domain/draft-trail-projection.js";
import {
  ALPHA_ID,
  closeDatabase,
  createTestDatabase,
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

  it("projects a direct live agent write into its settled trail", async () => {
    const persistence = createDrizzleCollabPersistence(db);
    const trail = createDrizzleChangeTrailAggregateWriter(db);
    const documentSchema = buildDocumentSchema();
    const codec = createAgentEditCodecFactory(mdxCodec({ schema: documentSchema }));
    const model = yProsemirrorModel(documentSchema);
    const beforeDoc = createCollabYDoc({ gc: false });
    model.insertBlocks(toDocHandle(beforeDoc), null, codec.parse("Alpha base."));
    await persistence.seeds.seedInitialDocument(ALPHA_ID, Y.encodeStateAsUpdate(beforeDoc));

    const afterDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(beforeDoc));
    const block = model.getBlocks(toDocHandle(afterDoc))[0];
    if (!block) throw new Error("live test document has no block");
    const beforeUpdate = Y.encodeStateVector(afterDoc);
    model.applyTextEdit(toDocHandle(afterDoc), block, { from: 0, to: 5 }, "Gamma");
    const update = Y.encodeStateAsUpdate(afterDoc, beforeUpdate);

    const projectLiveTrail = createLiveTrailProjector({
      model,
      codec,
      links: (() => {
        const links = createStaticDocumentLinkScopes();
        return {
          within: (_key, operation) => operation(),
          prepare: async () => {},
          holder: links.holder,
          reader: links.reader,
          branchCreatedAt: links.branchCreatedAt,
          pinHolder: links.pinHolder,
        };
      })(),
      persistence: trail,
      resolveDocumentTitle: async () => "alpha",
    });
    persistence.setLiveTrailProjector(async (input) => {
      if (!input.mutation.turnId) return;
      await projectLiveTrail({
        documentId: input.documentId,
        beforeState: input.beforeState,
        afterState: input.afterState,
        receiptId: input.receiptId,
        threadId: input.mutation.threadId,
        turnId: input.mutation.turnId,
      });
    });
    await grantedJournal(persistence.journal).appendBatch([
      {
        docId: ALPHA_ID,
        update,
        meta: { origin: `agent:${TURN_ID}`, actorTurnId: TURN_ID, seq: 0 },
        mutation: {
          mode: "live",
          actorKind: "agent",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          writeId: "live-write",
          editParts: [update],
        },
      },
    ]);

    await trail.reconcileTerminalOwners();
    await trail.reconcileTerminalOwners();
    const trailId = trailIdForOwner({ kind: "turn", threadId: THREAD_ID, turnId: TURN_ID });
    const [shell] = await db
      .select()
      .from(schema.changeTrailShells)
      .where(eq(schema.changeTrailShells.id, trailId));
    const [detail] = await db
      .select()
      .from(schema.changeTrailDocumentDetails)
      .where(eq(schema.changeTrailDocumentDetails.trailId, trailId));
    expect(shell).toMatchObject({ state: "settled", changeCount: 1, documentCount: 1 });
    expect(detail?.changes).toEqual([
      expect.objectContaining({
        kind: "modify",
        beforeText: expect.stringContaining("Alpha base."),
        afterTextAtReceipt: expect.stringContaining("Gamma base."),
      }),
    ]);
    beforeDoc.destroy();
    afterDoc.destroy();
  });
});
