/**
 * One reply, several destinations (D9, D19, D29, D40): a reply that writes
 * live scratch and a drafted document reads its own writes, undoes as one turn,
 * leaves out archived Works at save, and merges live writes into kept drafts.
 */

import type { WorkId } from "@meridian/contracts/runtime";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import type { AgentEditDestination } from "./contracts.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("reply save destinations (postgres)", () => {});
} else {
  describe("reply save destinations (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("./composition.js");
    const { createDrizzleDocumentAccess } = await import("../../lib/document-access.js");
    const { createDrizzleProjectWorkAuthorityResolver } = await import("../projects/index.js");
    const { DOCUMENT_RUNTIME_RESET_TABLES, deleteDrizzleRows } = await import(
      "../../test-support/drizzle-reset.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000a01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000a02";
    const KB_SOURCE_ID = "00000000-0000-4000-8000-000000000a03";
    const SCRATCH_SOURCE_ID = "00000000-0000-4000-8000-000000000a04";
    const WORK_ID = "00000000-0000-4000-8000-000000000a05";
    const KB_ID = "00000000-0000-4000-8000-000000000a07";
    const SCRATCH_ID = "00000000-0000-4000-8000-000000000a08";
    const THREAD_ID = "00000000-0000-4000-8000-000000000a09";
    const TURN_ID = "00000000-0000-4000-8000-000000000a10";
    const RESPONSE_ID = "00000000-0000-4000-8000-000000000a11";

    const draft: AgentEditDestination = {
      kind: "draft",
      workId: WORK_ID as WorkId,
      workSlug: "rewrite",
    };
    const live: AgentEditDestination = { kind: "live" };
    const ctx = { threadId: THREAD_ID as never, turnId: TURN_ID as never };
    const context = (destination: AgentEditDestination) => ({
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      destination,
    });

    const db = createDb(DATABASE_URL, { max: 4 });
    const hocuspocus = fakeHocuspocus();
    const collabs: Array<{ dispose(): void }> = [];
    const createTestCollab = (options: { livePullDebounceMs?: number } = {}) => {
      const collab = createCollabDomain({
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        documentAccess: createDrizzleDocumentAccess(db),
        ...options,
      });
      collab.bindHocuspocus(hocuspocus as never);
      collabs.push(collab);
      return collab;
    };

    afterEach(() => {
      for (const collab of collabs.splice(0)) collab.dispose();
    });
    type Collab = ReturnType<typeof createTestCollab>;

    beforeEach(async () => {
      hocuspocus.documents.clear();
      await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "save-destinations"));
      await db
        .insert(schema.projects)
        .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "save-destinations" });
      await db.insert(schema.works).values([
        {
          id: WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Rewrite",
          slug: "rewrite",
          aiWriteMode: "draft",
        },
      ]);
      await db.insert(schema.contextSources).values([
        {
          id: KB_SOURCE_ID,
          projectId: PROJECT_ID,
          name: "Knowledge Base",
          slug: "kb",
          scope: "project",
        },
        {
          id: SCRATCH_SOURCE_ID,
          workId: WORK_ID,
          name: "Scratch",
          slug: "scratch",
          scope: "work",
        },
      ]);
      await db.insert(schema.documents).values([
        { id: KB_ID, contextSourceId: KB_SOURCE_ID, name: "lore", extension: "md" },
        { id: SCRATCH_ID, contextSourceId: SCRATCH_SOURCE_ID, name: "notes", extension: "md" },
      ]);
      await db.insert(schema.threads).values({
        rootThreadId: THREAD_ID,
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.turns).values({
        id: TURN_ID as never,
        threadId: THREAD_ID as never,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.modelResponses).values({
        id: RESPONSE_ID as never,
        turnId: TURN_ID as never,
        sequence: 1,
        provider: "fixture",
        model: "fixture",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      await db
        .insert(schema.threadWorks)
        .values({ threadId: THREAD_ID, workId: WORK_ID, projectId: PROJECT_ID, isPrimary: true });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    async function seed(collab: Collab) {
      for (const [documentId, markdown] of [
        [KB_ID, "Lore base."],
        [SCRATCH_ID, "Notes base."],
      ] as const) {
        await collab.writeDocument({
          documentId: documentId as never,
          markdown,
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
      }
    }

    /** Stages one scratch write (live) and one `kb://` write (draft) in one reply. */
    async function stageMixedReply(collab: Collab) {
      await seed(collab);
      const agentEdit = collab.agentEdit();
      await expect(
        agentEdit.read({ file: "notes.md", documentId: SCRATCH_ID }, context(live)),
      ).resolves.toMatchObject({ status: "success" });
      await expect(
        agentEdit.read({ file: "lore.md", documentId: KB_ID }, context(draft)),
      ).resolves.toMatchObject({ status: "success" });
      await expect(
        agentEdit.write(
          { command: "insert", file: "notes.md", documentId: SCRATCH_ID, content: "Agent notes." },
          { ...context(live), responseId: RESPONSE_ID },
        ),
      ).resolves.toMatchObject({ status: "success", phase: "staged" });
      await expect(
        agentEdit.write(
          { command: "insert", file: "lore.md", documentId: KB_ID, content: "Agent lore." },
          { ...context(draft), responseId: RESPONSE_ID },
        ),
      ).resolves.toMatchObject({ status: "success", phase: "staged" });
    }

    async function liveText(collab: Collab, documentId: string): Promise<string> {
      const read = await collab.readAsMarkdown(documentId);
      return read.ok ? read.value : "";
    }

    async function draftText(collab: Collab, documentId: string): Promise<string> {
      const read = await collab.readEffectiveMarkdown({
        documentId: documentId as never,
        threadId: THREAD_ID as never,
        destination: "draft",
      });
      return read.ok ? read.value.content : "";
    }

    async function agentLiveRows(documentId: string) {
      return db
        .select({ id: schema.documentYjsUpdates.id })
        .from(schema.documentYjsUpdates)
        .where(
          and(
            eq(schema.documentYjsUpdates.documentId, documentId as never),
            eq(schema.documentYjsUpdates.originType, "agent"),
          ),
        );
    }

    it("reads its own scratch write, then saves and undoes the mixed turn as one", async () => {
      const collab = createTestCollab();
      await stageMixedReply(collab);
      // Scratch reads back inside the reply after the later kb write.
      const read = await collab
        .agentEdit()
        .read(
          { file: "notes.md", documentId: SCRATCH_ID },
          { ...context(live), responseId: RESPONSE_ID },
        );
      expect(JSON.stringify(read.result)).toContain("Agent notes.");
      await collab.finalizeResponseCommit(RESPONSE_ID, ctx);
      expect(await liveText(collab, SCRATCH_ID)).toContain("Agent notes.");
      expect(await draftText(collab, KB_ID)).toContain("Agent lore.");

      await expect(collab.getTurnReceiptChip(ctx.threadId, ctx.turnId)).resolves.toEqual(
        expect.objectContaining({ control: "undo" }),
      );
      const undone = await collab.reverseTurn({
        ...ctx,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(["reversed", "reconciled"]).toContain(undone.status);
      expect(await liveText(collab, SCRATCH_ID)).not.toContain("Agent notes.");
      expect(await draftText(collab, KB_ID)).not.toContain("Agent lore.");
    });

    it("leaves out a document whose Work was archived before the save and commits the rest", async () => {
      const collab = createTestCollab();
      await db
        .update(schema.works)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.works.id, WORK_ID));
      await seed(collab);
      const agentEdit = collab.agentEdit();
      for (const [file, documentId, content] of [
        ["notes.md", SCRATCH_ID, "Agent notes."],
        ["lore.md", KB_ID, "Agent lore."],
      ] as const) {
        await expect(
          agentEdit.write(
            { command: "insert", file, documentId, content },
            { ...context(live), responseId: RESPONSE_ID },
          ),
        ).resolves.toMatchObject({ status: "success", phase: "staged" });
      }
      await db
        .update(schema.works)
        .set({ archivedAt: new Date() })
        .where(eq(schema.works.id, WORK_ID));

      const committed = await collab.finalizeResponseCommit(RESPONSE_ID, ctx);

      expect(committed).toMatchObject({
        status: "committed",
        refused: [{ documentId: SCRATCH_ID, reason: "work_archived", workSlug: "rewrite" }],
      });
      expect(committed.documents.map((document) => document.documentId)).toEqual([KB_ID]);
      expect(await liveText(collab, KB_ID)).toContain("Agent lore.");
      expect(await liveText(collab, SCRATCH_ID)).not.toContain("Agent notes.");
      expect(await agentLiveRows(SCRATCH_ID)).toEqual([]);
    });

    /** A kept Work draft of lore.md, then an AI live write to it saved in one reply. */
    async function saveLiveWriteOverKeptDraft(collab: Collab) {
      await seed(collab);
      const agentEdit = collab.agentEdit();
      await agentEdit.read({ file: "lore.md", documentId: KB_ID }, context(draft));
      await agentEdit.write(
        { command: "insert", file: "lore.md", documentId: KB_ID, content: "Pending lore." },
        context(draft),
      );

      await agentEdit.read({ file: "lore.md", documentId: KB_ID }, context(live));
      await agentEdit.write(
        { command: "insert", file: "lore.md", documentId: KB_ID, content: "Live lore." },
        { ...context(live), responseId: RESPONSE_ID },
      );
      await collab.finalizeResponseCommit(RESPONSE_ID, ctx);
      expect(await liveText(collab, KB_ID)).toContain("Live lore.");
      expect(await liveText(collab, KB_ID)).not.toContain("Pending lore.");

      const [workDraft] = await db
        .select()
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.documentId, KB_ID as never),
            eq(schema.documentBranches.kind, "work_draft"),
            isNull(schema.documentBranches.threadId),
          ),
        );
      if (!workDraft) throw new Error("expected a kept Work draft for lore.md");
      return async () => {
        const [row] = await db
          .select({ state: schema.documentBranches.state })
          .from(schema.documentBranches)
          .where(eq(schema.documentBranches.id, workDraft.id));
        return markdownOf(row?.state);
      };
    }

    it("merges an AI live write into the document's kept Work draft", async () => {
      const draftText = await saveLiveWriteOverKeptDraft(
        createTestCollab({ livePullDebounceMs: 10 }),
      );

      // The scheduled live pull merges without any model read.
      const deadline = Date.now() + 5_000;
      let drafted = "";
      while (Date.now() < deadline) {
        drafted = await draftText();
        if (drafted.includes("Live lore.")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(drafted).toContain("Live lore.");
      expect(drafted).toContain("Pending lore.");
    });
  });
}

function markdownOf(state: Uint8Array | undefined): string {
  if (!state) return "";
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, state);
    return doc.getXmlFragment("prosemirror").toString();
  } finally {
    doc.destroy();
  }
}

function fakeHocuspocus() {
  const documents = new Map<string, Y.Doc>();
  return {
    documents,
    async openDirectConnection(documentName: string) {
      let document = documents.get(documentName);
      if (!document) {
        document = new Y.Doc({ gc: false });
        documents.set(documentName, document);
      }
      return { document, disconnect: async () => undefined };
    },
  };
}
