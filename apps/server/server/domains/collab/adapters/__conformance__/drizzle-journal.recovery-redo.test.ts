/** Recovery/redo integration tests using the Drizzle journal against local Postgres. */
import {
  createAgentEditCore,
  type DocumentCoordinator,
  DocumentNotFoundError,
  mdxCodec,
  type ReversalStore,
  type UpdateJournal,
  type WriteContext,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import {
  AGENT_EDIT_UNDO_CLIENT_ID,
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
  RESERVED_CLIENT_ID_MAX,
} from "@meridian/prosemirror-schema";
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
const CONCURRENT_TURNS = [
  "00000000-0000-4000-8000-00000000020b",
  "00000000-0000-4000-8000-00000000020c",
  "00000000-0000-4000-8000-00000000020d",
  "00000000-0000-4000-8000-00000000020e",
  "00000000-0000-4000-8000-00000000020f",
  "00000000-0000-4000-8000-000000000210",
  "00000000-0000-4000-8000-000000000211",
  "00000000-0000-4000-8000-000000000212",
] as const;
const LIVE_CLIENT_ID = RESERVED_CLIENT_ID_MAX + 1;
const REVERSAL_CLIENT_ID = AGENT_EDIT_UNDO_CLIENT_ID;

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle journal (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle journal recovery/redo (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const dbSchema = await import("@meridian/database/schema");
    const {
      contextSources,
      agentEditMutations,
      agentEditWidCounters,
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

    const db = createDb(DATABASE_URL, { max: 4 });

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [
        agentEditMutations,
        agentEditWidCounters,
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
        ...CONCURRENT_TURNS.map((id) => ({
          id,
          threadId: THREAD_ID,
          parentTurnId: TURN_E,
          role: "assistant" as const,
          status: "complete" as const,
        })),
      ]);
    }

    async function mutationRows() {
      return db
        .select({
          wId: agentEditMutations.wId,
          documentId: agentEditMutations.documentId,
          threadId: agentEditMutations.threadId,
          turnId: agentEditMutations.turnId,
          status: agentEditMutations.status,
          createdSeq: agentEditMutations.createdSeq,
          undoUpdateSeq: agentEditMutations.undoUpdateSeq,
          reversedBy: agentEditMutations.reversedBy,
        })
        .from(agentEditMutations)
        .where(eq(agentEditMutations.documentId, DOC_ID))
        .orderBy(asc(agentEditMutations.wId));
    }

    beforeEach(async () => {
      await truncateAll();
      await ensureFixtures();
    });

    afterAll(async () => {
      await db.close();
    });

    it("cold redo targets the latest reversed same-turn subset through Drizzle", async () => {
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
      const turnContext = { ...context, turnId: TURN_A };

      expect(outcomeText(await core.write({ command: "view", file: DOC_ID }, context))).toContain(
        "Alpha sword.",
      );
      expect(
        outcomeText(
          await core.write(
            { command: "replace", file: DOC_ID, find: "Alpha", content: "Beta" },
            turnContext,
          ),
        ),
      ).toContain("status: success");
      expect(outcomeText(await core.write({ command: "undo", file: DOC_ID }, context))).toContain(
        "status: reversed",
      );
      expect(
        outcomeText(
          await core.write(
            { command: "replace", file: DOC_ID, find: "sword", content: "blade" },
            turnContext,
          ),
        ),
      ).toContain("status: success");
      expect(outcomeText(await core.write({ command: "undo", file: DOC_ID }, context))).toContain(
        "status: reversed",
      );
      expect(blockTexts(coordinator.require(DOC_ID))).toEqual(["Alpha sword."]);

      const firstBeforeRedo = await journal.mutationsForWrite?.(DOC_ID, THREAD_ID, "w1");
      const secondBeforeRedo = await journal.mutationsForWrite?.(DOC_ID, THREAD_ID, "w2");
      if (!firstBeforeRedo || !secondBeforeRedo) throw new Error("expected write mutation rows");
      expect(firstBeforeRedo).toMatchObject([
        { wId: 1, status: "reversed", undoUpdateSeq: expect.any(Number) },
      ]);
      expect(secondBeforeRedo).toMatchObject([
        { wId: 2, status: "reversed", undoUpdateSeq: expect.any(Number) },
      ]);
      expect(secondBeforeRedo[0]?.undoUpdateSeq).not.toBe(firstBeforeRedo[0]?.undoUpdateSeq);

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
      expect(outcomeText(await restarted.redoTurn(DOC_ID, THREAD_ID))).toContain(
        "status: reversed",
      );

      expect(blockTexts(coordinator.require(DOC_ID))).toEqual(["Alpha blade."]);
      expect(await journal.mutationsForWrite?.(DOC_ID, THREAD_ID, "w1")).toMatchObject([
        { wId: 1, status: "reversed", undoUpdateSeq: firstBeforeRedo[0]?.undoUpdateSeq },
      ]);
      expect(await journal.mutationsForWrite?.(DOC_ID, THREAD_ID, "w2")).toMatchObject([
        { wId: 2, status: "active" },
      ]);
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

      expect(outcomeText(await core.write({ command: "view", file: DOC_ID }, context))).toContain(
        "Alpha sword.",
      );
      expect(
        outcomeText(
          await core.write(
            { command: "replace", file: DOC_ID, find: "sword", content: "blade" },
            { ...context, turnId: TURN_A },
          ),
        ),
      ).toContain("status: success");
      expect(blockTexts(coordinator.require(DOC_ID))).toEqual(["Alpha blade."]);
      expect(await mutationRows()).toMatchObject([
        { turnId: TURN_A, status: "active", wId: 1, undoUpdateSeq: null },
      ]);

      const undo = outcomeText(await core.write({ command: "undo", file: DOC_ID }, context));
      expect(undo).toContain("status: reversed");
      expect(blockTexts(coordinator.require(DOC_ID))).toEqual(["Alpha sword."]);
      expect(await mutationRows()).toMatchObject([
        { turnId: TURN_A, status: "reversed", wId: 1, reversedBy: "agent" },
      ]);
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
      expect(
        outcomeText(await restarted.write({ command: "view", file: DOC_ID }, context)),
      ).toContain("Alpha sword.");

      const redo = outcomeText(await restarted.write({ command: "redo", file: DOC_ID }, context));
      expect(redo).toContain("status: reversed");
      expect(blockTexts(coordinator.require(DOC_ID))).toEqual(["Alpha blade."]);
      expect(await mutationRows()).toMatchObject([
        { turnId: TURN_A, status: "active", wId: 1, undoUpdateSeq: null, reversedBy: null },
      ]);
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
    private readonly journal?: UpdateJournal & ReversalStore,
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

function outcomeText(outcome: { text: string }): string {
  return outcome.text;
}

function createDoc(markdown: string, clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  const root = schema.node("doc", null, codec.parse(markdown).blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  doc.clientID = clientID;
  return doc;
}

function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(doc).map((block) => model.getText(block));
}
