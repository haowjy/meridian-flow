/** Public collab-domain reverseTurn coverage over Drizzle branch infrastructure. */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("collab domain reverseTurn (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("collab domain reverseTurn (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const {
      agentEditMutations,
      branchWriteJournal,
      contextSources,
      documentBranches,
      documentYjsCheckpoints,
      documentYjsHeads,
      documentYjsReversalOps,
      documentYjsReversals,
      documentYjsUpdates,
      documents,
      projects,
      pushLineage,
      threadWorks,
      threads,
      turns,
      users,
      works,
    } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("./composition.js");
    const { checkDependentLaterLiveRows } = await import("./adapters/drizzle-live-dependencies.js");
    const { decodeUpdateForDependencies, deleteRanges, rangesOverlap, suppliedRanges } =
      await import("./domain/journal-dependencies.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");

    const USER_ID = "00000000-0000-4000-8000-000000000701";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000702";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000703";
    const WORK_ID = "00000000-0000-4000-8000-000000000704";
    const DOC_ID = "00000000-0000-4000-8000-000000000705";
    const THREAD_ID = "00000000-0000-4000-8000-000000000706";
    const TURN_ID = "00000000-0000-4000-8000-000000000707";
    const TURN_2_ID = "00000000-0000-4000-8000-000000000708";
    const TURN_3_ID = "00000000-0000-4000-8000-000000000709";
    const CREATED_DOC_ID = "00000000-0000-4000-8000-000000000710";

    const db = createDb(DATABASE_URL, { max: 4 });
    const hocuspocus = fakeHocuspocus();

    beforeEach(async () => {
      hocuspocus.documents.clear();
      await truncateDrizzleTables(db, [
        documentYjsReversalOps,
        documentYjsReversals,
        agentEditMutations,
        branchWriteJournal,
        pushLineage,
        documentBranches,
        documentYjsCheckpoints,
        documentYjsHeads,
        documentYjsUpdates,
        threadWorks,
        turns,
        threads,
        documents,
        contextSources,
        works,
        projects,
        users,
      ]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "collab-reverse"));
      await db
        .insert(projects)
        .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "project" });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Work",
        aiWriteMode: "draft",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(documents).values({
        id: DOC_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(turns).values([
        {
          id: TURN_ID as never,
          threadId: THREAD_ID as never,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_2_ID as never,
          threadId: THREAD_ID as never,
          parentTurnId: TURN_ID as never,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_3_ID as never,
          threadId: THREAD_ID as never,
          parentTurnId: TURN_2_ID as never,
          role: "assistant",
          status: "complete",
        },
      ]);
      await db
        .insert(threadWorks)
        .values({ threadId: THREAD_ID, workId: WORK_ID, projectId: PROJECT_ID, isPrimary: true });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("reverses a pushed draft turn through public reverseTurn without creating branch rows", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      const write = await collab.agentEdit().write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOC_ID,
          content: "Live undo target.",
        },
        { sessionId: "session", threadId: THREAD_ID, turnId: TURN_ID },
      );
      expect(write.status).toBe("success");
      const [workDraft] = await db
        .select()
        .from(documentBranches)
        .where(
          and(
            eq(documentBranches.documentId, DOC_ID as never),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        )
        .limit(1);
      expect(workDraft).toBeDefined();
      await collab.pushToLive({ branchId: workDraft.id });
      await expectMarkdown(collab, DOC_ID, "Live undo target.");

      const beforeThreadPeers = await countActiveThreadPeers();
      const beforeActiveBranchRows = await countActiveBranchRows();

      const reversed = await collab.reverseTurn({
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });

      expect(reversed.status).toBe("reversed");
      const live = await collab.readAsMarkdown(DOC_ID);
      expect(live.ok ? live.value : "").not.toContain("Live undo target.");
      expect(await countActiveThreadPeers()).toBe(beforeThreadPeers);
      expect(await countActiveBranchRows()).toBe(beforeActiveBranchRows);
      await expectMarkdown(collab, DOC_ID, "Base.");

      const reversalRows = await db
        .select({ status: documentYjsReversals.status })
        .from(documentYjsReversals)
        .where(
          and(
            eq(documentYjsReversals.threadId, THREAD_ID as never),
            eq(documentYjsReversals.turnId, TURN_ID as never),
          ),
        );
      expect(reversalRows.map((row) => row.status)).toContain("reversed");
      await expect(
        collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
      ).resolves.toEqual(expect.objectContaining({ state: "live-reversed", control: "redo" }));
    });

    it("degrades live turn undo when a later writer edit intersects the pushed paragraph", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      await collab.agentEdit().write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOC_ID,
          content: "Agent paragraph.",
        },
        { sessionId: "session-live-dependent", threadId: THREAD_ID, turnId: TURN_ID },
      );
      const [workDraft] = await activeWorkDraft();
      await collab.pushToLive({ branchId: workDraft.id });

      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.\n\nAgent HUMAN-KEEP paragraph.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      await expect(
        collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
      ).resolves.toEqual(
        expect.objectContaining({ state: "cant_undo_dependent", control: "view_change" }),
      );
      const reversed = await collab.reverseTurn({
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(reversed.status).toBe("cant_undo_dependent");
      expect(await readMarkdown(collab, DOC_ID)).toContain("Agent HUMAN-KEEP paragraph.");
    });

    it("detects a live dependency carried only by rightOrigin", async () => {
      const doc = new Y.Doc({ gc: false });
      const text = doc.getText("content");
      const beforeAgent = Y.encodeStateVector(doc);
      text.insert(0, "agent");
      const agentUpdate = Y.encodeStateAsUpdate(doc, beforeAgent);
      const selectedRanges = suppliedRanges(decodeUpdateForDependencies(agentUpdate));

      const beforeWriter = Y.encodeStateVector(doc);
      text.insert(0, "W");
      const writerUpdate = Y.encodeStateAsUpdate(doc, beforeWriter);
      const writerDecoded = decodeUpdateForDependencies(writerUpdate);
      const [writerStruct] = writerDecoded.structs ?? [];
      const rightOrigin = writerStruct?.rightOrigin;
      expect(rightOrigin).toBeDefined();
      expect(writerStruct?.origin).toBeNull();
      expect(deleteRanges(writerDecoded)).toHaveLength(0);
      expect(
        rightOrigin &&
          selectedRanges.some((range) => rangesOverlap(range, { ...rightOrigin, length: 1 })),
      ).toBe(true);

      const [agentRow] = await db
        .insert(documentYjsUpdates)
        .values({
          documentId: DOC_ID as never,
          updateData: Buffer.from(agentUpdate),
          originType: "agent",
          actorTurnId: TURN_ID as never,
        })
        .returning({ id: documentYjsUpdates.id });
      if (!agentRow) throw new Error("expected agent update row");
      await db.insert(agentEditMutations).values({
        wId: 1,
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        writeId: "right-origin-fixture",
        status: "active",
        createdSeq: agentRow.id,
      });
      await db.insert(documentYjsUpdates).values({
        documentId: DOC_ID as never,
        updateData: Buffer.from(writerUpdate),
        originType: "human",
        actorUserId: USER_ID as never,
      });

      await expect(
        checkDependentLaterLiveRows(db, {
          documentId: DOC_ID,
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
        }),
      ).resolves.toMatchObject({ hasDependents: true });
    });

    it("keeps live turn undo available when a later writer edit is elsewhere", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      await collab.agentEdit().write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOC_ID,
          content: "Agent paragraph.",
        },
        { sessionId: "session-live-independent", threadId: THREAD_ID, turnId: TURN_ID },
      );
      const [workDraft] = await activeWorkDraft();
      await collab.pushToLive({ branchId: workDraft.id });

      const unrelatedDoc = new Y.Doc({ gc: false });
      unrelatedDoc.getMap("elsewhere").set("note", "writer edit outside the agent paragraph");
      await db.insert(documentYjsUpdates).values({
        documentId: DOC_ID as never,
        updateData: Buffer.from(Y.encodeStateAsUpdate(unrelatedDoc)),
        originType: "human",
        actorUserId: USER_ID as never,
        actorTurnId: null,
      });
      unrelatedDoc.destroy();

      await expect(
        collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
      ).resolves.toEqual(expect.objectContaining({ state: "live-active", control: "undo" }));
      const reversed = await collab.reverseTurn({
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(reversed.status).toBe("reversed");
      const live = await readMarkdown(collab, DOC_ID);
      expect(live).toContain("Base.");
      expect(live).not.toContain("Agent paragraph.");
    });

    it("writes file-only public thread-peer commands with a branch generation", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: DOC_ID,
            content: "File-only thread peer.",
          },
          { sessionId: "session-file-only", threadId: THREAD_ID, turnId: TURN_ID },
        ),
      ).resolves.toMatchObject({ status: "success" });

      const rows = await db
        .select({
          generation: branchWriteJournal.generation,
          source: branchWriteJournal.source,
          status: branchWriteJournal.status,
        })
        .from(branchWriteJournal);
      expect(rows).toEqual([
        expect.objectContaining({ generation: 1, source: "agent", status: "active" }),
      ]);
    });

    it("durably commits two same-response staged writes to one document", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      const responseId = "response-same-document-db";
      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "First same response.",
          },
          {
            sessionId: "session-same-response-db",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId,
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Second same response.",
          },
          {
            sessionId: "session-same-response-db",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId,
          },
        ),
      ).resolves.toMatchObject({ status: "success" });

      await collab.finalizeResponseCommit(responseId, {
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
      });

      const rows = await db
        .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .orderBy(branchWriteJournal.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ status: "active" }));
      const pending = await collab.draftReview.preview({
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
        documentId: DOC_ID as never,
      });
      expect(pending.status).toBe("active");
      expect(await readMarkdown(collab, DOC_ID)).toContain("Base.");
    });

    it("lists reviewable drafts with resolved document name and manuscript context path", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Draft content for listing.",
          },
          {
            sessionId: "session-list-uri-db",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-list-uri-db",
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await collab.finalizeResponseCommit("response-list-uri-db", {
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
      });

      const drafts = await collab.draftReview.list({
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
      });
      expect(drafts).toHaveLength(1);
      // The dock's Review verb navigates by contextPath; null here silently
      // breaks review-from-dock for every document. The leading slash is
      // load-bearing: the client's findContextFile matches route paths
      // exactly, so a bare path opens an empty editor.
      expect(drafts[0]).toMatchObject({
        documentId: DOC_ID,
        documentName: "chapter",
        contextPath: "/chapter.md",
      });
      expect(drafts[0]).not.toHaveProperty("createdDocument");
    });

    it("materializes a new document and its live manifest entry on partial create accept", async () => {
      await db.insert(documents).values({
        id: CREATED_DOC_ID,
        contextSourceId: SOURCE_ID,
        name: "created-chapter",
        extension: "md",
        fileType: "markdown",
      });
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);

      await collab.recordManifestDocumentCreated(CREATED_DOC_ID as never, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });
      const responseId = "response-created-document-partial-accept";
      await expect(
        collab.agentEdit().write(
          {
            command: "create",
            file: "created-chapter.md",
            documentId: CREATED_DOC_ID,
            content: "# Created chapter\n\nOpening line.",
          },
          {
            sessionId: "session-created-document",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId,
            createdDocument: true,
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await collab.finalizeResponseCommit(responseId, {
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
      });

      const preview = await collab.draftReview.preview({
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        documentId: CREATED_DOC_ID as never,
      });
      expect(preview).toMatchObject({ status: "active", isNewDocument: true });
      if (preview.status !== "active" || !preview.branchId) throw new Error("missing preview");
      await expect(
        collab.draftReview.list({
          projectId: PROJECT_ID as never,
          workId: WORK_ID as never,
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentId: CREATED_DOC_ID,
            createdDocument: true,
          }),
        ]),
      );
      const createOperation = preview.operations[0];
      if (!createOperation) throw new Error("missing create operation");

      await expect(
        collab.draftReview.accept({
          projectId: PROJECT_ID as never,
          workId: WORK_ID as never,
          documentId: CREATED_DOC_ID as never,
          branchId: preview.branchId,
          userId: USER_ID as never,
          draftRevisionToken: preview.draftRevisionToken,
          operationIds: [createOperation.operationId],
        }),
      ).resolves.toMatchObject({ status: "partial_applied" });

      const liveMembership = await collab.resolveManifestMembership({
        projectId: PROJECT_ID as never,
      });
      // The context tree is projected from this live membership; work-draft
      // membership alone must not satisfy the assertion.
      expect(liveMembership.members).toContain(CREATED_DOC_ID);
      await expect(readMarkdown(collab, CREATED_DOC_ID)).resolves.toContain("Opening line.");
    });

    it("durably commits two sequential staged responses in one thread runtime", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "First staged response.",
          },
          {
            sessionId: "session-sequential-db",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-sequential-db-a",
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await collab.finalizeResponseCommit("response-sequential-db-a", {
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
      });

      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Second staged response.",
          },
          {
            sessionId: "session-sequential-db",
            threadId: THREAD_ID,
            turnId: TURN_2_ID,
            responseId: "response-sequential-db-b",
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await collab.finalizeResponseCommit("response-sequential-db-b", {
        threadId: THREAD_ID as never,
        turnId: TURN_2_ID as never,
      });

      const rows = await db
        .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .orderBy(branchWriteJournal.id);
      expect(rows).toEqual([
        expect.objectContaining({ status: "active" }),
        expect.objectContaining({ status: "active" }),
      ]);
    });

    it("durably commits distinct responses that reuse a provider-local tool id", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "First reused tool id.",
            tool_use_id: "call_mock_write_1",
          },
          {
            sessionId: "session-reused-provider-tool-id-db",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-reused-provider-tool-id-db-a",
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await collab.finalizeResponseCommit("response-reused-provider-tool-id-db-a", {
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
      });

      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Second reused tool id.",
            tool_use_id: "call_mock_write_1",
          },
          {
            sessionId: "session-reused-provider-tool-id-db",
            threadId: THREAD_ID,
            turnId: TURN_2_ID,
            responseId: "response-reused-provider-tool-id-db-b",
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await collab.finalizeResponseCommit("response-reused-provider-tool-id-db-b", {
        threadId: THREAD_ID as never,
        turnId: TURN_2_ID as never,
      });

      const rows = await db
        .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .orderBy(branchWriteJournal.id);
      expect(rows).toEqual([
        expect.objectContaining({ status: "active" }),
        expect.objectContaining({ status: "active" }),
      ]);
    });

    it("durably commits a staged response after discarding an earlier response", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      await collab.agentEdit().write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOC_ID,
          content: "Discarded staged response.",
        },
        {
          sessionId: "session-discard-db",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: "response-discard-db-a",
        },
      );
      await collab.finalizeResponseCommit("response-discard-db-a", {
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
      });
      const [workDraft] = await db
        .select()
        .from(documentBranches)
        .where(
          and(
            eq(documentBranches.documentId, DOC_ID as never),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        )
        .limit(1);
      expect(workDraft).toBeDefined();
      const preview = await collab.draftReview.preview({
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
        documentId: DOC_ID as never,
      });
      expect(preview.status).toBe("active");
      const operationId = preview.status === "active" ? preview.operations[0]?.operationId : null;
      expect(operationId).toBeTruthy();
      await collab.draftReview.reject({
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
        documentId: DOC_ID as never,
        branchId: workDraft.id,
        userId: USER_ID as never,
        operationIds: [operationId as string],
      });

      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Second staged after discard.",
          },
          {
            sessionId: "session-discard-db",
            threadId: THREAD_ID,
            turnId: TURN_2_ID,
            responseId: "response-discard-db-b",
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await collab.finalizeResponseCommit("response-discard-db-b", {
        threadId: THREAD_ID as never,
        turnId: TURN_2_ID as never,
      });

      const rows = await db
        .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .orderBy(branchWriteJournal.id);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.status)).toEqual(["discarded", "active"]);
    });

    async function activeWorkDraft() {
      return db
        .select()
        .from(documentBranches)
        .where(
          and(
            eq(documentBranches.documentId, DOC_ID as never),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        )
        .limit(1);
    }

    async function countActiveThreadPeers() {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentBranches)
        .where(
          and(eq(documentBranches.kind, "thread_peer"), eq(documentBranches.status, "active")),
        );
      return row?.count ?? 0;
    }

    async function countActiveBranchRows() {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.status, "active"));
      return row?.count ?? 0;
    }
  });
}

async function expectMarkdown(
  collab: {
    readAsMarkdown(documentId: string): Promise<{ ok: true; value: string } | { ok: false }>;
  },
  documentId: string,
  expected: string,
) {
  const read = await collab.readAsMarkdown(documentId);
  expect(read.ok ? read.value : "").toContain(expected);
}

async function readMarkdown(
  collab: {
    readAsMarkdown(documentId: string): Promise<{ ok: true; value: string } | { ok: false }>;
  },
  documentId: string,
): Promise<string> {
  const read = await collab.readAsMarkdown(documentId);
  return read.ok ? read.value : "";
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
