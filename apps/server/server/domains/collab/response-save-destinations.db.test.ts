/**
 * One reply, several destinations (D9, D19, D29, D40): a reply that writes
 * live scratch and a drafted document reads its own writes, undoes as one turn,
 * leaves out archived Works at save, and merges live writes into kept drafts.
 * Every call carries a real file-access grant, confirmed under lock where the
 * write becomes durable (file-access §5, §5.2).
 */

import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import {
  type AgentChain,
  createDrizzleFileFacts,
  createFileAccess,
  createOwnerFileGrants,
  FileEditRefusedError,
  type FileGrant,
  isFileAccessDenied,
  type Principal,
} from "../file-policy/index.js";

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
    const WORK_B_ID = "00000000-0000-4000-8000-000000000a12";
    const SCRATCH_B_SOURCE_ID = "00000000-0000-4000-8000-000000000a13";
    const SCRATCH_B_ID = "00000000-0000-4000-8000-000000000a14";
    const THREAD_B_ID = "00000000-0000-4000-8000-000000000a15";
    const TURN_B_ID = "00000000-0000-4000-8000-000000000a16";
    const RESPONSE_B_ID = "00000000-0000-4000-8000-000000000a17";

    const ctx = { threadId: THREAD_ID as never, turnId: TURN_ID as never };

    const db = createDb(DATABASE_URL, { max: 6 });
    // Threads here carry no Agent binding; each acts as an `edit` agent in its Work.
    const chains = new Map<string, AgentChain>();
    const fileAccess = createFileAccess({
      facts: createDrizzleFileFacts(db),
      grants: createOwnerFileGrants(),
      readAgentChain: async (threadId) => {
        const chain = chains.get(threadId);
        if (!chain) throw new Error(`No agent chain for ${threadId}`);
        return chain;
      },
    });
    /** An `edit` agent in `workId`; in draft mode its drafted writes go to that Work's draft. */
    function agent(threadId: string, workId: string, draftMode: boolean): Principal {
      const chain: AgentChain = [
        { threadId: threadId as ThreadId, permission: "edit", threadWorkId: workId as WorkId },
      ];
      chains.set(threadId, chain);
      return {
        accountId: USER_ID as never,
        agent: {
          chain,
          draftWork: draftMode ? { id: workId as WorkId, slug: slugs.get(workId) ?? null } : null,
        },
      };
    }
    const slugs = new Map<string, string>([[WORK_ID, "rewrite"]]);
    const drafting = () => agent(THREAD_ID, WORK_ID, true);
    const direct = () => agent(THREAD_ID, WORK_ID, false);
    async function grant(principal: Principal, documentId: string): Promise<FileGrant<"edit">> {
      const granted = await fileAccess.authorize(
        principal,
        { kind: "document", documentId: documentId as never },
        "edit",
      );
      if (isFileAccessDenied(granted)) throw new Error(`Denied ${documentId}: ${granted.reason}`);
      return granted;
    }
    async function context(principal: Principal, documentId: string, threadId = THREAD_ID) {
      return {
        sessionId: threadId,
        threadId,
        turnId: threadId === THREAD_ID ? TURN_ID : TURN_B_ID,
        grant: await grant(principal, documentId),
      };
    }
    const hocuspocus = fakeHocuspocus();
    const collabs: Array<{ dispose(): void }> = [];
    const createTestCollab = (options: { livePullDebounceMs?: number } = {}) => {
      const collab = createCollabDomain({
        db,
        fileAccess,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        threadContext: {
          requireThreadOwner: async () => ({ projectId: PROJECT_ID as never }),
          resolveContextDocument: async () => {
            throw new Error("Turn reversals here name no document");
          },
        },
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
      const scratch = await context(drafting(), SCRATCH_ID);
      const lore = await context(drafting(), KB_ID);
      await expect(
        agentEdit.read({ file: "notes.md", documentId: SCRATCH_ID }, scratch),
      ).resolves.toMatchObject({ status: "success" });
      await expect(
        agentEdit.read({ file: "lore.md", documentId: KB_ID }, lore),
      ).resolves.toMatchObject({ status: "success" });
      await expect(
        agentEdit.write(
          { command: "insert", file: "notes.md", documentId: SCRATCH_ID, content: "Agent notes." },
          { ...scratch, responseId: RESPONSE_ID },
        ),
      ).resolves.toMatchObject({ status: "success", phase: "staged" });
      await expect(
        agentEdit.write(
          { command: "insert", file: "lore.md", documentId: KB_ID, content: "Agent lore." },
          { ...lore, responseId: RESPONSE_ID },
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
          { ...(await context(drafting(), SCRATCH_ID)), responseId: RESPONSE_ID },
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

    it("refuses an undo of an archived Work's scratch under the journal's locks", async () => {
      const collab = createTestCollab();
      await seed(collab);
      const agentEdit = collab.agentEdit();
      // Granted while the Work is active, as a call already past its preflight.
      const scratch = await context(direct(), SCRATCH_ID);
      await agentEdit.read({ file: "notes.md", documentId: SCRATCH_ID }, scratch);
      await agentEdit.write(
        { command: "insert", file: "notes.md", documentId: SCRATCH_ID, content: "Agent notes." },
        { ...scratch, responseId: RESPONSE_ID },
      );
      await collab.finalizeResponseCommit(RESPONSE_ID, ctx);
      await archiveWork(WORK_ID);

      const undo = agentEdit.write(
        { command: "undo", file: "notes.md", documentId: SCRATCH_ID },
        scratch,
      );

      await expect(undo).rejects.toBeInstanceOf(FileEditRefusedError);
      await expect(undo).rejects.toMatchObject({ refused: [{ reason: "work_archived" }] });
      expect(await liveText(collab, SCRATCH_ID)).toContain("Agent notes.");
    });

    it("leaves out a document whose Work is archived while the reply saves, and saves the rest", async () => {
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
            { ...(await context(direct(), documentId)), responseId: RESPONSE_ID },
          ),
        ).resolves.toMatchObject({ status: "success", phase: "staged" });
      }

      // The archive holds the Work row when the save starts, so the save waits
      // for it and re-checks the scratch file under the lock.
      let releaseArchive!: () => void;
      const archiveHeld = new Promise<void>((resolve) => {
        releaseArchive = resolve;
      });
      let archiveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        archiveStarted = resolve;
      });
      const archive = db.transaction(async (tx) => {
        await tx
          .update(schema.works)
          .set({ archivedAt: new Date() })
          .where(eq(schema.works.id, WORK_ID));
        archiveStarted();
        await archiveHeld;
      });
      await started;
      let saved = false;
      const save = collab.finalizeResponseCommit(RESPONSE_ID, ctx).finally(() => {
        saved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(saved).toBe(false);
      releaseArchive();
      await archive;
      const committed = await save;

      expect(committed).toMatchObject({
        status: "committed",
        refused: [
          {
            documentId: SCRATCH_ID,
            denial: { reason: "work_archived", archivedWork: { slug: "rewrite" } },
          },
        ],
      });
      expect(committed.documents.map((document) => document.documentId)).toEqual([KB_ID]);
      expect(await liveText(collab, KB_ID)).toContain("Agent lore.");
      expect(await liveText(collab, SCRATCH_ID)).not.toContain("Agent notes.");
      expect(await agentLiveRows(SCRATCH_ID)).toEqual([]);
    });

    it("saves two mixed replies whose Works overlap in opposite orders", async () => {
      const collab = createTestCollab();
      await addSecondWorkAndThread();
      await seed(collab);
      await collab.writeDocument({
        documentId: SCRATCH_B_ID as never,
        markdown: "B notes base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_B_ID as never,
      });
      const agentEdit = collab.agentEdit();
      // Each reply drafts lore.md into its own Work and writes the other Work's scratch.
      const replies = [
        { threadId: THREAD_ID, workId: WORK_ID, responseId: RESPONSE_ID, other: SCRATCH_B_ID },
        { threadId: THREAD_B_ID, workId: WORK_B_ID, responseId: RESPONSE_B_ID, other: SCRATCH_ID },
      ];
      for (const reply of replies) {
        const principal = agent(reply.threadId, reply.workId, true);
        for (const [file, documentId] of [
          ["lore.md", KB_ID],
          ["notes.md", reply.other],
        ] as const) {
          const call = await context(principal, documentId, reply.threadId);
          await expect(
            agentEdit.write(
              { command: "insert", file, documentId, content: `From ${reply.workId}.` },
              { ...call, responseId: reply.responseId },
            ),
          ).resolves.toMatchObject({ status: "success", phase: "staged" });
        }
      }

      const saved = await Promise.all(
        replies.map((reply) =>
          collab.finalizeResponseCommit(reply.responseId, {
            threadId: reply.threadId as never,
            turnId: (reply.threadId === THREAD_ID ? TURN_ID : TURN_B_ID) as never,
          }),
        ),
      );

      for (const result of saved)
        expect(result).toMatchObject({ status: "committed", refused: [] });
      expect(await liveText(collab, SCRATCH_ID)).toContain(`From ${WORK_B_ID}.`);
      expect(await liveText(collab, SCRATCH_B_ID)).toContain(`From ${WORK_ID}.`);
    });

    it("leaves an archived Work's draft as it is on the writer's turn undo and redo", async () => {
      const collab = createTestCollab();
      await seed(collab);
      const agentEdit = collab.agentEdit();
      const lore = await context(drafting(), KB_ID);
      await agentEdit.read({ file: "lore.md", documentId: KB_ID }, lore);
      await agentEdit.write(
        { command: "insert", file: "lore.md", documentId: KB_ID, content: "Agent lore." },
        { ...lore, responseId: RESPONSE_ID },
      );
      await collab.finalizeResponseCommit(RESPONSE_ID, ctx);
      // The writer owns lore.md, so their grant holds after the archive; the
      // draft it would change is what the archive froze (D30).
      const reverse = (direction: "undo" | "redo") =>
        collab.reverseThreadContext({
          threadId: THREAD_ID as never,
          userId: USER_ID,
          turnId: TURN_ID as never,
          direction,
          scope: "turn",
          selection: TURN_ID,
        });
      const refused = {
        status: "permission_denied",
        documents: [expect.objectContaining({ status: "permission_denied" })],
      };

      await archiveWork(WORK_ID);
      await expect(reverse("undo")).resolves.toMatchObject(refused);
      expect(await journalStatuses()).toEqual(["active"]);
      expect(await draftText(collab, KB_ID)).toContain("Agent lore.");

      await setArchived(WORK_ID, false);
      await expect(reverse("undo")).resolves.toMatchObject({ status: "reversed" });
      await archiveWork(WORK_ID);
      await expect(reverse("redo")).resolves.toMatchObject(refused);
      expect(await journalStatuses()).toEqual(["discarded"]);
    });

    async function journalStatuses() {
      const rows = await db
        .select({ status: schema.branchWriteJournal.status })
        .from(schema.branchWriteJournal)
        .where(eq(schema.branchWriteJournal.turnId, TURN_ID as never));
      return rows.map((row) => row.status);
    }

    async function archiveWork(workId: string) {
      await setArchived(workId, true);
    }

    async function setArchived(workId: string, archived: boolean) {
      await db
        .update(schema.works)
        .set({ archivedAt: archived ? new Date() : null })
        .where(eq(schema.works.id, workId));
    }

    /** Work B in draft mode with its own scratch file, and a thread in it with a reply. */
    async function addSecondWorkAndThread() {
      slugs.set(WORK_B_ID, "second");
      await db.insert(schema.works).values({
        id: WORK_B_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Second",
        slug: "second",
        aiWriteMode: "draft",
      });
      await db.insert(schema.contextSources).values({
        id: SCRATCH_B_SOURCE_ID,
        workId: WORK_B_ID,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
      });
      await db.insert(schema.documents).values({
        id: SCRATCH_B_ID,
        contextSourceId: SCRATCH_B_SOURCE_ID,
        name: "notes",
        extension: "md",
      });
      await db.insert(schema.threads).values({
        rootThreadId: THREAD_B_ID,
        id: THREAD_B_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread B",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.turns).values({
        id: TURN_B_ID as never,
        threadId: THREAD_B_ID as never,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.modelResponses).values({
        id: RESPONSE_B_ID as never,
        turnId: TURN_B_ID as never,
        sequence: 1,
        provider: "fixture",
        model: "fixture",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_B_ID,
        workId: WORK_B_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    }

    /** A kept Work draft of lore.md, then an AI live write to it saved in one reply. */
    async function saveLiveWriteOverKeptDraft(collab: Collab) {
      await seed(collab);
      const agentEdit = collab.agentEdit();
      const drafted = await context(drafting(), KB_ID);
      await agentEdit.read({ file: "lore.md", documentId: KB_ID }, drafted);
      await agentEdit.write(
        { command: "insert", file: "lore.md", documentId: KB_ID, content: "Pending lore." },
        drafted,
      );

      const live = await context(direct(), KB_ID);
      await agentEdit.read({ file: "lore.md", documentId: KB_ID }, live);
      await agentEdit.write(
        { command: "insert", file: "lore.md", documentId: KB_ID, content: "Live lore." },
        { ...live, responseId: RESPONSE_ID },
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

    it("undoes each write where it landed, and refuses one in an archived Work's draft", async () => {
      const collab = createTestCollab();
      const keptDraftText = await saveLiveWriteOverKeptDraft(collab);
      const agentEdit = collab.agentEdit();
      const undoLast = async () =>
        agentEdit.write(
          { command: "undo", file: "lore.md", documentId: KB_ID, last: 1 },
          await context(direct(), KB_ID),
        );

      // The live write came after the keep switch; the latest write is undone live.
      await expect(undoLast()).resolves.toMatchObject({ status: "reversed" });
      expect(await liveText(collab, KB_ID)).not.toContain("Live lore.");
      expect(await keptDraftText()).toContain("Pending lore.");

      // Now the latest is the drafted write, in a draft the archive froze.
      await archiveWork(WORK_ID);
      const frozen = undoLast();
      await expect(frozen).rejects.toBeInstanceOf(FileEditRefusedError);
      await expect(frozen).rejects.toMatchObject({
        refused: [{ reason: "work_archived", archivedWork: { slug: "rewrite" } }],
      });
      expect(await keptDraftText()).toContain("Pending lore.");
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
