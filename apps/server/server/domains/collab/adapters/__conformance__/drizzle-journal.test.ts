/** Contract tests for the Drizzle UpdateJournal adapter against local Postgres. */
import {
  createAgentEditCore,
  type DocumentCoordinator,
  DocumentNotFoundError,
  mdxCodec,
  reconstructUndoUpdateFromSnapshot,
  type UpdateJournal,
  type WriteContext,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000201";
const PROJECT_ID = "00000000-0000-4000-8000-000000000202";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000203";
const DOC_ID = "00000000-0000-4000-8000-000000000204";
const THREAD_ID = "00000000-0000-4000-8000-000000000205";
const TURN_A = "00000000-0000-4000-8000-000000000206";
const TURN_B = "00000000-0000-4000-8000-000000000207";
const TURN_C = "00000000-0000-4000-8000-000000000208";
const TURN_D = "00000000-0000-4000-8000-000000000209";
const TURN_E = "00000000-0000-4000-8000-00000000020a";
const MISSING_THREAD_ID = "00000000-0000-4000-8000-0000000002ff";
const LIVE_CLIENT_ID = 100;
const REVERSAL_CLIENT_ID = 9_999;

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle journal (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle journal (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const dbSchema = await import("@meridian/database/schema");
    const {
      contextSources,
      documentYjsCheckpoints,
      documentYjsHeads,
      documentYjsReversals,
      documentYjsUpdates,
      documents,
      folders,
      projects,
      threads,
      turns,
      users,
    } = dbSchema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { asc, eq } = await import("drizzle-orm");
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleJournal } = await import("../drizzle-journal.js");

    const db = createDb(DATABASE_URL, { max: 1 });

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [
        documentYjsReversals,
        documentYjsHeads,
        documentYjsUpdates,
        documentYjsCheckpoints,
        turns,
        threads,
        documents,
        folders,
        contextSources,
        projects,
        users,
      ]);
    }

    async function ensureFixtures(): Promise<void> {
      await db.insert(users).values(conformanceUserValues(USER_ID, "drizzle-journal"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Journal Project",
        slug: "journal-project",
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Journal Source",
        slug: "journal-source",
        scope: "project",
      });
      await db.insert(documents).values({
        id: DOC_ID,
        contextSourceId: CONTEXT_SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Journal Thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(turns).values([
        { id: TURN_A, threadId: THREAD_ID, role: "assistant", status: "complete" },
        {
          id: TURN_B,
          threadId: THREAD_ID,
          parentTurnId: TURN_A,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_C,
          threadId: THREAD_ID,
          parentTurnId: TURN_B,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_D,
          threadId: THREAD_ID,
          parentTurnId: TURN_C,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_E,
          threadId: THREAD_ID,
          parentTurnId: TURN_D,
          role: "assistant",
          status: "complete",
        },
      ]);
    }

    async function updateIds(): Promise<number[]> {
      const rows = await db
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, DOC_ID))
        .orderBy(asc(documentYjsUpdates.id));
      return rows.map((row) => row.id);
    }

    beforeEach(async () => {
      await truncateAll();
      await ensureFixtures();
    });

    afterAll(async () => {
      await db.close();
    });

    it("matches append/read/checkpoint/compact/reversal contract behavior", async () => {
      const journal = createDrizzleJournal(db);
      const doc = new Y.Doc({ gc: false });
      doc.clientID = LIVE_CLIENT_ID;

      const updateA = appendText(doc, "Alpha");
      const seqA = await journal.append(DOC_ID, updateA, {
        origin: `agent:${TURN_A}`,
        actorTurnId: TURN_A,
        seq: 0,
      });
      const updateB = appendText(doc, " Beta");
      const seqB = await journal.append(DOC_ID, updateB, {
        origin: `human:${USER_ID}`,
        actorTurnId: TURN_B,
        seq: 0,
      });
      const updateC = appendText(doc, " Gamma");
      const seqC = await journal.append(DOC_ID, updateC, { origin: "system", seq: 0 });

      expect(seqA).toBeLessThan(seqB);
      expect(seqB).toBeLessThan(seqC);

      const bounded = await journal.read(DOC_ID, { since: seqB, until: seqC });
      expect(bounded.updates.map((update) => update.seq)).toEqual([seqB, seqC]);

      const initial = await journal.read(DOC_ID);
      expect(initial.checkpoint).toBeNull();
      expect(initial.updates.map((update) => update.seq)).toEqual([seqA, seqB, seqC]);
      expect(initial.updates[0]?.meta).toEqual({
        origin: `agent:${TURN_A}`,
        actorTurnId: TURN_A,
        seq: seqA,
      });
      expect(initial.updates[1]?.meta).toEqual({
        origin: `human:${USER_ID}`,
        actorTurnId: TURN_B,
        seq: seqB,
      });
      expect(initial.updates[2]?.meta).toEqual({ origin: "system", seq: seqC });

      await journal.checkpoint(DOC_ID, Y.encodeStateAsUpdate(doc), seqC);
      const afterCheckpoint = await journal.read(DOC_ID);
      expect(afterCheckpoint.checkpoint).toBeInstanceOf(Uint8Array);
      expect(afterCheckpoint.updates).toEqual([]);

      const updateD = appendText(doc, " Delta");
      const seqD = await journal.append(DOC_ID, updateD, {
        origin: `agent:${TURN_C}`,
        actorTurnId: TURN_C,
        seq: 0,
      });
      const updateE = appendText(doc, " Epsilon");
      const seqE = await journal.append(DOC_ID, updateE, {
        origin: `agent:${TURN_D}`,
        actorTurnId: TURN_D,
        seq: 0,
      });
      expect((await journal.read(DOC_ID)).updates.map((update) => update.seq)).toEqual([
        seqD,
        seqE,
      ]);

      await db.insert(documentYjsReversals).values({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        turnId: TURN_D,
        status: "active",
        undoUpdateSeq: seqE,
        expiresAt: new Date("2000-01-01T00:00:00.000Z"),
      });

      const compacted = await journal.compact(DOC_ID, new Date("2100-01-01T00:00:00.000Z"));
      expect(compacted).toEqual({ updatesFolded: 2, reversalsExpired: 1 });
      const afterCompact = await journal.read(DOC_ID);
      expect(afterCompact.checkpoint).toBeInstanceOf(Uint8Array);
      expect(afterCompact.updates).toEqual([]);
      expect(textFromSnapshot(afterCompact.checkpoint, afterCompact.updates)).toBe(
        doc.getText("body").toString(),
      );
      const [expired] = await db
        .select({ status: documentYjsReversals.status })
        .from(documentYjsReversals)
        .where(eq(documentYjsReversals.turnId, TURN_D));
      expect(expired?.status).toBe("expired");

      const undoUpdate = appendText(doc, " Undo");
      const record = {
        documentId: DOC_ID,
        threadId: THREAD_ID,
        turnId: TURN_E,
        status: "reversed" as const,
        undoUpdateSeq: 0,
        reversedAt: new Date("2026-06-21T00:00:00.000Z"),
        reversedByUserId: USER_ID,
      };
      await journal.persistReversal(DOC_ID, undoUpdate, record);
      expect(record.undoUpdateSeq).toBeGreaterThan(seqE);

      const withUndo = await journal.read(DOC_ID);
      const persistedUndo = withUndo.updates.find((update) => update.seq === record.undoUpdateSeq);
      expect(persistedUndo).toBeDefined();
      expect(Array.from(persistedUndo?.update ?? [])).toEqual(Array.from(undoUpdate));
      expect(persistedUndo?.meta).toEqual({ origin: "system", seq: record.undoUpdateSeq });

      const [reversal] = await db
        .select()
        .from(documentYjsReversals)
        .where(eq(documentYjsReversals.turnId, TURN_E));
      expect(reversal).toMatchObject({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        turnId: TURN_E,
        status: "reversed",
        undoUpdateSeq: record.undoUpdateSeq,
        reversedByUserId: USER_ID,
      });

      const idsBeforeFailure = await updateIds();
      await expect(
        journal.persistReversal(DOC_ID, appendText(doc, " Rolled back"), {
          documentId: DOC_ID,
          threadId: MISSING_THREAD_ID,
          turnId: TURN_E,
          status: "reversed",
          undoUpdateSeq: 0,
        }),
      ).rejects.toThrow();
      expect(await updateIds()).toEqual(idsBeforeFailure);
      expect((await journal.read(DOC_ID)).updates.map((update) => update.seq)).toEqual([
        record.undoUpdateSeq,
      ]);

      const redoUpdate = appendText(doc, " Redo");
      const redo = await journal.persistRedo(
        DOC_ID,
        redoUpdate,
        { threadId: THREAD_ID, turnId: TURN_E },
        { origin: "system", seq: 0 },
      );
      expect(redo.consumed).toBe(true);
      expect(redo.seq).toBeGreaterThan(record.undoUpdateSeq);
      expect(
        await journal.readReversals(DOC_ID, { threadId: THREAD_ID, status: ["redone"] }),
      ).toMatchObject([{ turnId: TURN_E, status: "redone" }]);

      const idsAfterRedo = await updateIds();
      await expect(
        journal.persistRedo(
          DOC_ID,
          redoUpdate,
          { threadId: THREAD_ID, turnId: TURN_E },
          { origin: "system", seq: 0 },
        ),
      ).resolves.toEqual({ consumed: false });
      await expect(
        journal.persistRedo(
          DOC_ID,
          redoUpdate,
          { threadId: MISSING_THREAD_ID, turnId: TURN_E },
          { origin: "system", seq: 0 },
        ),
      ).resolves.toEqual({ consumed: false });
      expect(await updateIds()).toEqual(idsAfterRedo);
    });

    it("replays updates appended after checkpoint state was captured", async () => {
      const journal = createDrizzleJournal(db);
      const doc = new Y.Doc({ gc: false });
      doc.clientID = LIVE_CLIENT_ID;

      const updateA = appendText(doc, "Alpha");
      const seqA = await journal.append(DOC_ID, updateA, {
        origin: `agent:${TURN_A}`,
        actorTurnId: TURN_A,
        seq: 0,
      });
      const checkpointState = Y.encodeStateAsUpdate(doc);

      const updateB = appendText(doc, " Beta");
      const seqB = await journal.append(DOC_ID, updateB, {
        origin: `human:${USER_ID}`,
        seq: 0,
      });

      await journal.checkpoint(DOC_ID, checkpointState, seqA);

      const snapshot = await journal.read(DOC_ID);
      expect(snapshot.checkpoint).toBeInstanceOf(Uint8Array);
      expect(snapshot.updates.map((update) => update.seq)).toEqual([seqB]);
      expect(textFromSnapshot(snapshot.checkpoint, snapshot.updates)).toBe("Alpha Beta");
    });

    it("preserves hot/cold undo parity through createAgentEditCore", async () => {
      const journal = createDrizzleJournal(db);
      const liveDoc = createDoc("Alpha sword.\n\nBeta waits.", LIVE_CLIENT_ID);
      await journal.checkpoint(DOC_ID, Y.encodeStateAsUpdate(liveDoc), 0);

      const coordinator = new MemoryCoordinator([[DOC_ID, liveDoc]]);
      const core = createAgentEditCore({
        journal,
        coordinator,
        codec,
        model,
        undoClientId: REVERSAL_CLIENT_ID,
      });
      const context: WriteContext = { sessionId: "journal-session", threadId: THREAD_ID };

      expect(await core.write({ command: "view", file: DOC_ID }, context)).toContain("Alpha sword");
      expect(
        await core.write(
          { command: "replace", file: DOC_ID, find: "sword", content: "blade" },
          { ...context, turnId: TURN_A },
        ),
      ).toContain("status: success");
      expect(
        await core.write(
          { command: "replace", file: DOC_ID, find: "waits", content: "marches" },
          { ...context, turnId: TURN_B },
        ),
      ).toContain("status: success");
      expect(blockTexts(liveDoc)).toEqual(["Alpha blade.", "Beta marches."]);

      const snapshotBeforeUndo = await journal.read(DOC_ID);
      expect(snapshotBeforeUndo.updates.map((update) => update.meta.actorTurnId)).toEqual([
        TURN_A,
        TURN_B,
      ]);
      const preUndoDoc = cloneDoc(liveDoc, LIVE_CLIENT_ID);
      const beforeUndoVector = Y.encodeStateVector(liveDoc);
      const undoResult = await core.write({ command: "undo", file: DOC_ID }, context);
      expect(undoResult).toContain("status: reversed");
      const hotUndoUpdate = Y.encodeStateAsUpdate(liveDoc, beforeUndoVector);

      const cold = reconstructUndoUpdateFromSnapshot(snapshotBeforeUndo, {
        docId: DOC_ID,
        turnId: TURN_B,
        undoClientId: REVERSAL_CLIENT_ID,
      });
      const coldDoc = cloneDoc(preUndoDoc, LIVE_CLIENT_ID);
      Y.applyUpdate(coldDoc, cold.undoUpdate);

      expect(Array.from(cold.undoUpdate)).toEqual(Array.from(hotUndoUpdate));
      expect(blockTexts(coldDoc)).toEqual(blockTexts(liveDoc));
      expect(documentBytes(coldDoc)).toEqual(documentBytes(liveDoc));
    });

    it("rehydrates redo from reversal records after live doc recovery", async () => {
      const journal = createDrizzleJournal(db);
      const liveDoc = createDoc("Alpha sword.", LIVE_CLIENT_ID);
      await journal.checkpoint(DOC_ID, Y.encodeStateAsUpdate(liveDoc), 0);

      const coordinator = new MemoryCoordinator([[DOC_ID, liveDoc]], journal);
      const core = createAgentEditCore({
        journal,
        coordinator,
        codec,
        model,
        undoClientId: REVERSAL_CLIENT_ID,
      });
      const context: WriteContext = { sessionId: "journal-session", threadId: THREAD_ID };

      expect(await core.write({ command: "view", file: DOC_ID }, context)).toContain(
        "Alpha sword.",
      );
      expect(
        await core.write(
          { command: "replace", file: DOC_ID, find: "sword", content: "blade" },
          { ...context, turnId: TURN_A },
        ),
      ).toContain("status: success");
      expect(blockTexts(coordinator.require(DOC_ID))).toEqual(["Alpha blade."]);

      const undo = await core.write({ command: "undo", file: DOC_ID }, context);
      expect(undo).toContain("status: reversed");
      expect(blockTexts(coordinator.require(DOC_ID))).toEqual(["Alpha sword."]);
      const [reversal] = await journal.readReversals(DOC_ID, {
        threadId: THREAD_ID,
        status: ["reversed"],
      });
      expect(reversal).toMatchObject({ turnId: TURN_A, status: "reversed" });
      expect(reversal?.undoUpdateSeq).toBeGreaterThan(0);

      coordinator.discard(DOC_ID);
      await core.recover(DOC_ID);
      expect(blockTexts(coordinator.require(DOC_ID))).toEqual(["Alpha sword."]);

      const restarted = createAgentEditCore({
        journal,
        coordinator,
        codec,
        model,
        undoClientId: REVERSAL_CLIENT_ID,
      });
      expect(await restarted.write({ command: "view", file: DOC_ID }, context)).toContain(
        "Alpha sword.",
      );

      const redo = await restarted.write({ command: "redo", file: DOC_ID }, context);
      expect(redo).toContain("status: reversed");
      expect(blockTexts(coordinator.require(DOC_ID))).toEqual(["Alpha blade."]);
      expect(
        await journal.readReversals(DOC_ID, { threadId: THREAD_ID, status: ["reversed"] }),
      ).toEqual([]);
      expect(
        await journal.readReversals(DOC_ID, { threadId: THREAD_ID, status: ["redone"] }),
      ).toMatchObject([{ turnId: TURN_A, status: "redone" }]);
    });
  });
}

class MemoryCoordinator implements DocumentCoordinator {
  private readonly docs = new Map<string, Y.Doc>();

  constructor(
    entries: Iterable<readonly [string, Y.Doc]>,
    private readonly journal?: UpdateJournal,
  ) {
    for (const [docId, doc] of entries) this.docs.set(docId, doc);
  }

  require(docId: string): Y.Doc {
    const doc = this.docs.get(docId);
    if (!doc) throw new DocumentNotFoundError(docId);
    return doc;
  }

  async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    return fn(this.require(docId));
  }

  discard(docId: string): void {
    this.docs.delete(docId);
  }

  async recover(docId: string): Promise<void> {
    if (!this.journal) return;
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = new Y.Doc({ gc: false });
      this.docs.set(docId, doc);
    }
    const snapshot = await this.journal.read(docId);
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint, { type: "system" });
    for (const update of snapshot.updates) Y.applyUpdate(doc, update.update, { type: "system" });
  }
}

function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.insert(text.toString().length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

function textFromSnapshot(
  checkpoint: Uint8Array | null,
  updates: readonly { update: Uint8Array }[],
): string {
  const doc = new Y.Doc({ gc: false });
  if (checkpoint) Y.applyUpdate(doc, checkpoint);
  for (const update of updates) Y.applyUpdate(doc, update.update);
  return doc.getText("body").toString();
}

function createDoc(markdown: string, clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  const root = schema.node("doc", null, codec.parse(markdown).blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  doc.clientID = clientID;
  return doc;
}

function cloneDoc(source: Y.Doc, clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  doc.clientID = clientID;
  return doc;
}

function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(doc).map((block) => model.getText(block));
}

function documentBytes(doc: Y.Doc): number[] {
  return Array.from(Y.encodeStateAsUpdate(doc));
}
