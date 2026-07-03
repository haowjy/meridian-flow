/** Integration proof for draft-scoped agent-edit response commits. */
import type { Hocuspocus } from "@hocuspocus/server";
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createAgentEditResponseWriteLifecycle,
  createWiredCoreToolRegistrations,
} from "../../../lib/wired-core-tools.js";
import type { ContextPort } from "../../context/index.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import {
  createDrizzleDraftAcceptJournal,
  createDrizzleDraftStore,
} from "../adapters/drizzle-drafts.js";
import { createDrizzleCollabPersistence } from "../adapters/drizzle-journal.js";
import { createDrizzleTurnLiveLineageStore } from "../adapters/drizzle-turn-live-lineage.js";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
} from "../adapters/in-memory/agent-edit.js";
import { createInMemoryDraftAcceptJournal } from "../adapters/in-memory/drafts.js";
import {
  type CollabFacadeStore,
  createDrizzleDraftSessionCore,
  createFacade,
} from "../composition.js";
import { updateMarkdownProjection } from "../domain/document-activity.js";
import { createDraftReviewLease } from "../domain/draft-review-lease.js";
import { createTurnLiveLineageReadModel } from "../domain/turn-live-lineage.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000501" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-000000000502";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000503";
const DOC_ID = "00000000-0000-4000-8000-000000000504" as DocumentId;
const DOC_B_ID = "00000000-0000-4000-8000-000000000507" as DocumentId;
const CREATED_DOC_ID = "00000000-0000-4000-8000-00000000050a" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-00000000050b" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000505" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000506" as TurnId;
const LATER_TURN_ID = "00000000-0000-4000-8000-000000000508" as TurnId;
const TEST_CLAIM_TOKEN = "00000000-0000-4000-8000-000000000509";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("draft session core (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("draft session core write-to-draft persistence (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const dbSchema = await import("@meridian/database/schema");
    const {
      agentEditMutations,
      agentEditSyncState,
      agentEditWidCounters,
      contextSources,
      documentYjsDrafts,
      documentYjsCheckpoints,
      documentYjsDraftUpdates,
      documentYjsHeads,
      documentYjsReversalOps,
      documentYjsReversals,
      documentYjsUpdates,
      documents,
      folders,
      projects,
      threads,
      threadWorks,
      turnBlocks,
      turns,
      users,
      works,
    } = dbSchema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const db = createDb(DATABASE_URL, { max: 4 });
    let draftStore = createDrizzleDraftStore(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        documentYjsReversalOps,
        documentYjsReversals,
        documentYjsDraftUpdates,
        documentYjsDrafts,
        agentEditSyncState,
        agentEditMutations,
        agentEditWidCounters,
        documentYjsUpdates,
        documentYjsCheckpoints,
        documentYjsHeads,
        turnBlocks,
        turns,
        threadWorks,
        threads,
        documents,
        folders,
        contextSources,
        works,
        projects,
        users,
      ]);
      draftStore = createDrizzleDraftStore(db);
      await db.insert(users).values(conformanceUserValues(USER_ID, "draft-session-core"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Draft Core Project",
        slug: "draft-core-project",
      });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Draft Core Work",
        aiWriteMode: "draft",
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Draft Core Source",
        slug: "draft-core-source",
        scope: "project",
      });
      await db.insert(documents).values([
        {
          id: DOC_ID,
          contextSourceId: CONTEXT_SOURCE_ID,
          name: "chapter",
          extension: "md",
          fileType: "markdown",
        },
        {
          id: DOC_B_ID,
          contextSourceId: CONTEXT_SOURCE_ID,
          name: "chapter-b",
          extension: "md",
          fileType: "markdown",
        },
      ]);
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Draft Core Thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(threadWorks).values({
        threadId: THREAD_ID,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
      await db.insert(turns).values({
        id: TURN_ID,
        threadId: THREAD_ID,
        role: "assistant",
        status: "complete",
      });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    async function insertCreatedDocumentRow(db: Database, label: string): Promise<void> {
      await db.insert(documents).values({
        id: CREATED_DOC_ID,
        contextSourceId: CONTEXT_SOURCE_ID,
        name: label,
        extension: "md",
        fileType: "markdown",
      });
    }

    async function createCreatedDocumentDraft(
      db: Database,
      domain: ReturnType<typeof createFacade>,
      label: string,
    ) {
      await insertCreatedDocumentRow(db, label);
      await expect(
        domain.agentEdit().write(
          {
            command: "create",
            file: `${label}.md`,
            documentId: CREATED_DOC_ID,
            content: `Created draft content ${label}.`,
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: `response-created-${label}` },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        domain.finalizeResponseCommit(`response-created-${label}`, {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "committed" });
      const draft = await draftStore.getActiveDraft({
        documentId: CREATED_DOC_ID,
        threadId: THREAD_ID,
      });
      if (!draft) throw new Error("expected active created-document draft");
      expect(draft.createdDocument).toBe(true);
      return draft;
    }

    function wiredWriteForCreatedDocument(db: Database, domain: ReturnType<typeof createFacade>) {
      const port = createdDocumentContextPort(db);
      const responseWrites = createAgentEditResponseWriteLifecycle({ documentSync: domain });
      const [writeRegistration] = createWiredCoreToolRegistrations({
        threads: { findById: async () => threadRow() } as never,
        threadWorks: {
          findPrimary: async () => ({ workId: WORK_ID }),
          listByThread: async () => [{ workId: WORK_ID, isPrimary: true }],
        },
        contextPorts: { forProject: () => port, forWork: () => port },
        documentSync: domain,
        responseWrites,
        eventSink: createInMemoryEventSink(),
      });
      if (writeRegistration?.definition.name !== "write") throw new Error("missing write tool");
      if (writeRegistration.execution.type !== "server")
        throw new Error("write tool must be server-backed");
      return {
        write: writeRegistration.execution.handler as (
          input: unknown,
          ctx: ReturnType<typeof toolContext>,
        ) => Promise<unknown>,
        responseWrites,
      };
    }

    function createdDocumentContextPort(db: Database): ContextPort {
      let created = false;
      return {
        stat: async (uri) => {
          const [row] = await db
            .select({ id: documents.id })
            .from(documents)
            .where(eq(documents.id, CREATED_DOC_ID))
            .limit(1);
          return row
            ? {
                ok: true,
                value: {
                  kind: "tracked",
                  uri,
                  documentId: CREATED_DOC_ID,
                  filetype: "markdown",
                  schemaType: "document",
                },
              }
            : { ok: false, error: { code: "not_found", uri } };
        },
        ensureTrackedDocument: async () => {
          if (!created) {
            created = true;
            await insertCreatedDocumentRow(db, "created");
          }
          return { ok: true, value: { documentId: CREATED_DOC_ID, created } };
        },
        delete: async () => {
          await db.delete(documents).where(eq(documents.id, CREATED_DOC_ID));
          return { ok: true, value: undefined };
        },
        list: async () => ({ ok: true, value: [] }),
        search: async () => ({ ok: true, value: [] }),
        read: async () => ({ ok: false, error: { code: "not_found", uri: "created.md" } }),
        write: async () => ({ ok: false, error: { code: "invalid_operation", uri: "created.md" } }),
        edit: async () => ({ ok: false, error: { code: "invalid_operation", uri: "created.md" } }),
        writeBinary: async () => ({
          ok: false,
          error: { code: "invalid_operation", uri: "created.md" },
        }),
        move: async () => ({ ok: false, error: { code: "invalid_operation", uri: "created.md" } }),
        mkdir: async () => ({ ok: true, value: undefined }),
      };
    }

    function toolContext(responseId: string) {
      return {
        signal: new AbortController().signal,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId,
        agentSlug: null,
        toolCallId: undefined,
      };
    }

    function threadRow() {
      return {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        workId: WORK_ID,
        userId: USER_ID,
        kind: "primary",
        status: "active",
        title: null,
        currentAgent: null,
        parentThreadId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    async function createdDocumentRowCount(): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(eq(documents.id, CREATED_DOC_ID));
      return row?.count ?? 0;
    }

    async function createdDocumentDraftRowCount(): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentYjsDrafts)
        .where(eq(documentYjsDrafts.documentId, CREATED_DOC_ID));
      return row?.count ?? 0;
    }

    async function draftMutationRowCount(draftId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentEditMutations)
        .where(eq(agentEditMutations.scopeId, draftId));
      return row?.count ?? 0;
    }

    async function draftSyncStateRowCount(draftId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentEditSyncState)
        .where(eq(agentEditSyncState.scopeId, draftId));
      return row?.count ?? 0;
    }

    it("commits response writes into draft updates and applies them only after accept", async () => {
      const { domain, liveCoordinator, liveJournal } = createLiveHarness(db, draftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const before = await readMarkdown(domain, DOC_ID);
      const draftCore = createDrizzleDraftSessionCore({
        db,
        threadId: THREAD_ID,
        liveCoordinator,
        draftStore,
      });

      await expect(
        draftCore.write(
          { command: "read", file: "chapter.md", documentId: DOC_ID },
          { threadId: THREAD_ID, turnId: TURN_ID },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        draftCore.write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Draft Beta.",
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-draft" },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(draftCore.commitResponse("response-draft")).resolves.toMatchObject({
        documentCount: 1,
        updateCount: 1,
      });

      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      expect(draft).toMatchObject({ status: "active", lastActorTurnId: TURN_ID });
      if (!draft) throw new Error("expected active draft");
      expect(await draftStore.listUpdates(draft.id)).toHaveLength(1);
      expect(await readMarkdown(domain, DOC_ID)).toBe(before);

      const mutationRows = await db
        .select({ scopeId: agentEditMutations.scopeId })
        .from(agentEditMutations)
        .where(
          and(
            eq(agentEditMutations.documentId, DOC_ID),
            eq(agentEditMutations.threadId, THREAD_ID),
          ),
        );
      expect(mutationRows).toEqual([{ scopeId: draft.id }]);

      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      expect(await readMarkdown(domain, DOC_ID)).toContain("Draft Beta.");
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "applied" });
      expect(liveJournal.updateRecords(DOC_ID).length).toBeGreaterThan(1);
    });

    it("accepts a draft on top of live edits made after the draft commit", async () => {
      const { domain, liveCoordinator } = createLiveHarness(db, draftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draftCore = createDrizzleDraftSessionCore({
        db,
        threadId: THREAD_ID,
        liveCoordinator,
        draftStore,
      });
      await draftCore.write(
        { command: "read", file: "chapter.md", documentId: DOC_ID },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );
      await draftCore.write(
        { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Draft Beta." },
        { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-draft-merge" },
      );
      await draftCore.commitResponse("response-draft-merge");
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      await domain.editDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        transform: (markdown) => `${markdown}\n\nLive Gamma.`,
        origin: { type: "user", actorUserId: USER_ID },
      });
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Draft Beta.");

      await domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      });
      const afterAccept = await readMarkdown(domain, DOC_ID);
      expect(afterAccept).toContain("Draft Beta.");
      expect(afterAccept).toContain("Live Gamma.");
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "applied" });
    });

    it("routes facade response writes to draft mode, skips live projection refresh, then accepts", async () => {
      const hook = vi.fn(async (event) => {
        await updateMarkdownProjection(db, event.documentId, event.markdown, event.at);
      });
      const { domain } = createLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
        documentWriteHook: hook,
      });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      hook.mockClear();
      const before = await readMarkdown(domain, DOC_ID);

      await expect(
        domain
          .agentEdit()
          .write(
            { command: "read", file: "chapter.md", documentId: DOC_ID },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-facade-draft" },
          ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Draft Beta." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-facade-draft" },
          ),
      ).resolves.toMatchObject({ isError: false });

      await expect(
        domain.finalizeResponseCommit("response-facade-draft", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toEqual({
        status: "committed",
        documents: [{ documentId: DOC_ID, updateCount: 1 }],
        stagedCreates: { committed: [], discarded: [] },
      });
      expect(await readMarkdown(domain, DOC_ID)).toBe(before);
      expect(hook).not.toHaveBeenCalled();

      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      expect(draft).toMatchObject({ status: "active", lastActorTurnId: TURN_ID });
      if (!draft) throw new Error("expected active draft");

      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      expect(await readMarkdown(domain, DOC_ID)).toContain("Draft Beta.");
      expect(hook).toHaveBeenCalledTimes(1);
      const [projection] = await db
        .select({ markdownProjection: documents.markdownProjection })
        .from(documents)
        .where(eq(documents.id, DOC_ID))
        .limit(1);
      expect(projection?.markdownProjection).toContain("Draft Beta.");
    });

    it("creates a draft-mode document through the wired write tool and marks the draft as a created document", async () => {
      const { domain } = createDrizzleLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      const { write, responseWrites } = wiredWriteForCreatedDocument(db, domain);

      await expect(
        write(
          { command: "create", path: "created.md", content: "Created draft content." },
          toolContext("response-created-tool"),
        ),
      ).resolves.toMatchObject({ metadata: { documentId: CREATED_DOC_ID } });
      await expect(
        responseWrites.commitResponse("response-created-tool", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toEqual({ status: "committed", concurrentEdits: [] });

      const draft = await draftStore.getActiveDraft({
        documentId: CREATED_DOC_ID,
        threadId: THREAD_ID,
      });
      expect(draft).toMatchObject({
        status: "active",
        createdDocument: true,
        lastActorTurnId: TURN_ID,
      });
      expect(await createdDocumentRowCount()).toBe(1);
      expect(draft ? await draftStore.listUpdates(draft.id) : []).toHaveLength(1);
    });

    it("rejecting a created-document draft deletes the placeholder and all draft-scoped state", async () => {
      const { domain } = createDrizzleLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      const draft = await createCreatedDocumentDraft(db, domain, "reject");

      await expect(
        domain.drafts.rejectDraft({
          documentId: CREATED_DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
        }),
      ).resolves.toEqual({ status: "discarded", draftId: draft.id });

      await expect(draftStore.getDraft(draft.id)).resolves.toBeNull();
      expect(await createdDocumentRowCount()).toBe(0);
      await expect(draftStore.listUpdates(draft.id)).resolves.toEqual([]);
      expect(await draftMutationRowCount(draft.id)).toBe(0);
      expect(await draftSyncStateRowCount(draft.id)).toBe(0);
    });

    it("accepting a created-document draft materializes live content and keeps the document row", async () => {
      const { domain } = createDrizzleLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      const draft = await createCreatedDocumentDraft(db, domain, "accept");

      await expect(
        domain.drafts.acceptDraft({
          documentId: CREATED_DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });

      await expect(draftStore.getDraft(draft.id)).resolves.toBeNull();
      expect(await createdDocumentRowCount()).toBe(1);
      await expect(readMarkdown(domain, CREATED_DOC_ID)).resolves.toContain(
        "Created draft content accept.",
      );
    });

    it("compensates a failed created-document response commit by deleting the active draft and placeholder", async () => {
      let failProjection = false;
      const failing = createDrizzleLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
        coordinatorFactory(base) {
          return {
            async withDocument(documentId, fn) {
              if (failProjection)
                throw new Error("simulated projection failure after journal commit");
              return base.withDocument(documentId, fn);
            },
            async recover(documentId) {
              if (failProjection) throw new Error("simulated projection recovery failure");
              return base.recover(documentId);
            },
          };
        },
      });
      await insertCreatedDocumentRow(db, "failed");
      await expect(
        failing.domain.agentEdit().write(
          {
            command: "create",
            file: "failed.md",
            documentId: CREATED_DOC_ID,
            content: "Created draft content failed.",
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-created-fail" },
        ),
      ).resolves.toMatchObject({ isError: false });
      failProjection = true;

      await expect(
        failing.domain.finalizeResponseCommit("response-created-fail", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).rejects.toThrow("response-created-fail commit failed after journal append");

      expect(await createdDocumentRowCount()).toBe(0);
      expect(await createdDocumentDraftRowCount()).toBe(0);
      expect(await failing.domain.drafts.listReviewableDrafts({ threadId: THREAD_ID })).toEqual([]);
    });

    it("refuses a legacy created-document draft that has no live document head", async () => {
      await insertCreatedDocumentRow(db, "invalid");
      const draft = await draftStore.createActiveDraft({
        documentId: CREATED_DOC_ID,
        threadId: THREAD_ID,
        lastActorTurnId: TURN_ID,
      });
      const { domain } = createDrizzleLiveHarness(db, draftStore, { aiWriteMode: "draft" });

      await expect(
        domain.drafts.acceptDraft({
          documentId: CREATED_DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toEqual({ status: "invalid_created_document", draftId: draft.id });
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "active" });
    });

    it("lets only one concurrent draft finalizer mutate live state", async () => {
      const { domain, liveCoordinator } = createDrizzleLiveHarness(db, draftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draftCore = createDrizzleDraftSessionCore({
        db,
        threadId: THREAD_ID,
        liveCoordinator,
        draftStore,
      });
      await draftCore.write(
        { command: "read", file: "chapter.md", documentId: DOC_ID },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );
      await draftCore.write(
        { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Draft Beta." },
        { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-concurrent" },
      );
      await draftCore.commitResponse("response-concurrent");
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      const [accept, reject] = await Promise.all([
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
        domain.drafts.rejectDraft({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id }),
      ]);

      const final = await draftStore.getDraft(draft.id);
      const statuses = [accept.status, reject.status].sort();
      expect([["applied", "not_found"].sort(), ["discarded", "not_found"].sort()]).toContainEqual(
        statuses,
      );
      if (accept.status === "applied") {
        expect(final?.status).toBe("applied");
        expect(await readMarkdown(domain, DOC_ID)).toContain("Draft Beta.");
      } else {
        expect(final?.status).toBe("discarded");
        expect(await readMarkdown(domain, DOC_ID)).not.toContain("Draft Beta.");
      }
    });

    it("B1: fences stale accept after reject reclaims an expired claim before live journal append", async () => {
      const { domain, liveCoordinator } = createDrizzleLiveHarness(db, draftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await createCommittedDraft(db, liveCoordinator, draftStore, "reclaim-reject");

      const staleClaim = await claimActiveForTest(db, documentYjsDrafts, draft.id);
      expect(staleClaim).toMatchObject({ id: draft.id, status: "active" });
      if (!staleClaim?.claimToken) throw new Error("expected stale claim token");
      await expireClaim(db, documentYjsDrafts, draft.id);

      await expect(
        domain.drafts.rejectDraft({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id }),
      ).resolves.toEqual({
        status: "discarded",
        draftId: draft.id,
      });

      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toEqual({ status: "not_found" });
      const mutationRows = await db
        .select({ writeId: agentEditMutations.writeId })
        .from(agentEditMutations)
        .where(eq(agentEditMutations.writeId, `draft-accept:${draft.id}`));
      expect(mutationRows).toHaveLength(0);
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "discarded" });
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Draft reclaim-reject.");
      const restart = createDrizzleLiveHarness(db, draftStore);
      await restart.liveCoordinator.recover(DOC_ID);
      expect(await readMarkdown(restart.domain, DOC_ID)).not.toContain("Draft reclaim-reject.");
    });

    it("treats exact-draft applied retries as idempotent after reclaiming an expired active claim", async () => {
      const { domain, liveCoordinator, liveJournal } = createLiveHarness(db, draftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await createCommittedDraft(db, liveCoordinator, draftStore, "reclaim-accept");

      const staleClaim = await claimActiveForTest(db, documentYjsDrafts, draft.id);
      expect(staleClaim).toMatchObject({ id: draft.id, status: "active" });
      if (!staleClaim?.claimToken) throw new Error("expected stale claim token");
      await expireClaim(db, documentYjsDrafts, draft.id);

      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });

      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "applied" });
      const after = await readMarkdown(domain, DOC_ID);
      expect(after).toContain("Draft reclaim-accept.");
      expect(after.match(/Draft reclaim-accept\./g)).toHaveLength(1);
      expect(
        liveJournal
          .mutationRecords(DOC_ID)
          .filter((mutation) => mutation.writeId === `draft-accept:${draft.id}`),
      ).toHaveLength(1);
    });

    it("does not let a pending draft response recreate a draft after invalidation", async () => {
      let releasePreferences!: () => void;
      const preferencesReady = new Promise<void>((resolve) => {
        releasePreferences = resolve;
      });
      let delayPreferences = false;
      const { domain } = createLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
        beforePreferenceRead: () => (delayPreferences ? preferencesReady : Promise.resolve()),
      });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      await domain
        .agentEdit()
        .write(
          { command: "read", file: "chapter.md", documentId: DOC_ID },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-before-close" },
        );
      await domain
        .agentEdit()
        .write(
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "First draft." },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-before-close" },
        );
      await domain.finalizeResponseCommit("response-before-close", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      delayPreferences = true;
      const pendingWrite = domain
        .agentEdit()
        .write(
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Stale draft." },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-pending-close" },
        );
      await domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      });
      releasePreferences();

      await expect(pendingWrite).resolves.toMatchObject({
        isError: true,
        status: "internal_error",
      });
      await expect(
        domain.finalizeResponseCommit("response-pending-close", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "draft_closed" });
      expect(
        await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID }),
      ).toBeNull();
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Stale draft.");
    });

    it("B2: thread-wide invalidation stops stale responses that had not touched the closed document", async () => {
      const { domain } = createLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      await domain.writeDocument({
        documentId: DOC_B_ID,
        threadId: THREAD_ID,
        markdown: "Other live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      await domain
        .agentEdit()
        .write(
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "First draft." },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-first-draft" },
        );
      await domain.finalizeResponseCommit("response-first-draft", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      await expect(
        domain.agentEdit().write(
          {
            command: "insert",
            file: "chapter-b.md",
            documentId: DOC_B_ID,
            content: "Other draft.",
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-other-doc" },
        ),
      ).resolves.toMatchObject({ isError: false });

      await domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      });
      await expect(
        domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Stale draft." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-other-doc" },
          ),
      ).resolves.toMatchObject({ isError: true, status: "internal_error" });
      await expect(
        domain.finalizeResponseCommit("response-other-doc", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "draft_closed" });
      expect(
        await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID }),
      ).toBeNull();
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Stale draft.");
    });

    it("B2: append-time DB fence stops a stale response from recreating a closed draft", async () => {
      const { domain, liveCoordinator } = createLiveHarness(db, draftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await createCommittedDraft(db, liveCoordinator, draftStore, "append-fence");
      const staleCore = createDrizzleDraftSessionCore({
        db,
        threadId: THREAD_ID,
        liveCoordinator,
        draftStore,
      });

      await staleCore.write(
        { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Stale append." },
        { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-append-fence" },
      );
      await expect(
        domain.drafts.rejectDraft({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id }),
      ).resolves.toEqual({ status: "discarded", draftId: draft.id });

      await expect(staleCore.commitResponse("response-append-fence")).rejects.toThrow(
        "Draft review was closed before this response could commit",
      );
      expect(
        await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID }),
      ).toBeNull();
      expect(await draftStore.listUpdates(draft.id)).toHaveLength(1);
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Stale append.");
    });

    it("B2: review lease rejects agent writes with a distinct draft_under_review result", async () => {
      const releaseCallbacks: Array<() => void> = [];
      const draftReviewLease = createDraftReviewLease({
        setTimer(fn) {
          releaseCallbacks.push(fn);
          return releaseCallbacks.length;
        },
        clearTimer() {},
      });
      const { domain } = createLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
        draftReviewLease,
      });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      await domain
        .agentEdit()
        .write(
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "First draft." },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-create-draft" },
        );
      await domain.finalizeResponseCommit("response-create-draft", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      domain.enterDraftReview({ draftId: draft.id, socketId: "socket-1", userId: USER_ID });
      await expect(
        domain.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Blocked during review.",
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-under-review" },
        ),
      ).resolves.toMatchObject({ isError: true, status: "draft_under_review" });
      await expect(
        domain.finalizeResponseCommit("response-under-review", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "draft_under_review" });
      expect((await draftStore.listUpdates(draft.id)).map((row) => row.actorTurnId)).toEqual([
        TURN_ID,
      ]);

      domain.leaveDraftReview({ draftId: draft.id, socketId: "socket-1" });
      await expect(
        domain.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Still blocked during grace.",
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-under-review-grace" },
        ),
      ).resolves.toMatchObject({ isError: true, status: "draft_under_review" });

      for (const release of releaseCallbacks) release();

      await expect(
        domain.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Allowed after review.",
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-after-review" },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        domain.finalizeResponseCommit("response-after-review", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "committed" });
      expect(await draftStore.listUpdates(draft.id)).toHaveLength(2);
    });

    it("B2: review lease does not block writer accept or reject finalization", async () => {
      const draftReviewLease = createDraftReviewLease();
      const { domain } = createLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
        draftReviewLease,
      });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      await domain
        .agentEdit()
        .write(
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "First draft." },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-finalize-lease" },
        );
      await domain.finalizeResponseCommit("response-finalize-lease", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      domain.enterDraftReview({ draftId: draft.id, socketId: "socket-1", userId: USER_ID });

      await expect(
        domain.drafts.rejectDraft({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id }),
      ).resolves.toEqual({ status: "discarded", draftId: draft.id });
      expect(
        await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID }),
      ).toBeNull();
    });

    it("B3: applied retry recovers live doc after journal append succeeds but live apply crashes", async () => {
      let failNextApply = false;
      const { domain, liveCoordinator, liveStore } = createDrizzleLiveHarness(db, draftStore, {
        coordinatorFactory(base) {
          return {
            withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
              if (failNextApply) {
                failNextApply = false;
                throw new Error("simulated crash after completeAccept");
              }
              return base.withDocument(documentId, fn);
            },
            recover: base.recover,
          };
        },
      });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await createCommittedDraft(db, liveCoordinator, draftStore, "recovery", {
        latestLiveUpdateSeq: liveStore.latestUpdateSeq,
      });

      failNextApply = true;
      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
          confirmOverlap: true,
          confirmedLiveRevisionToken: await liveStore.latestUpdateSeq(DOC_ID),
        }),
      ).rejects.toThrow("simulated crash after completeAccept");
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "applied" });
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Draft recovery.");

      const retry = createDrizzleLiveHarness(db, draftStore);
      await expect(
        retry.domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      expect(await readMarkdown(retry.domain, DOC_ID)).toContain("Draft recovery.");
    });

    it("SF6: concurrent second accept reports in_progress instead of not_found", async () => {
      let releaseFirstAccept!: () => void;
      const firstAcceptBlocked = new Promise<void>((resolve) => {
        const release = new Promise<void>((releaseResolve) => {
          releaseFirstAccept = releaseResolve;
        });
        const baseBeginAccept = draftStore.beginAccept.bind(draftStore);
        draftStore = {
          ...draftStore,
          async beginAccept(input) {
            const result = await baseBeginAccept(input);
            if (result.status === "claimed") {
              resolve();
              await release;
            }
            return result;
          },
        };
      });
      const { domain, liveCoordinator } = createDrizzleLiveHarness(db, draftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await createCommittedDraft(db, liveCoordinator, draftStore, "double-accept");

      const firstAccept = domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      });
      await firstAcceptBlocked;
      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toEqual({ status: "in_progress", draftId: draft.id });
      releaseFirstAccept();
      await expect(firstAccept).resolves.toMatchObject({ status: "applied", draftId: draft.id });
    });

    it("retries draft scoped cleanup after an applied retry", async () => {
      let cleanupCalls = 0;
      const flakyDraftStore = {
        ...draftStore,
        async recoverAccepted(input: Parameters<typeof draftStore.recoverAccepted>[0]) {
          cleanupCalls += 1;
          if (cleanupCalls === 1) throw new Error("cleanup failed once");
          await draftStore.recoverAccepted(input);
        },
      };
      const { domain, liveCoordinator } = createLiveHarness(db, flakyDraftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draftCore = createDrizzleDraftSessionCore({
        db,
        threadId: THREAD_ID,
        liveCoordinator,
        draftStore,
      });
      await draftCore.write(
        { command: "read", file: "chapter.md", documentId: DOC_ID },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );
      await draftCore.write(
        { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Draft Beta." },
        { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-cleanup-retry" },
      );
      await draftCore.commitResponse("response-cleanup-retry");
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).rejects.toThrow("cleanup failed once");
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "applied" });
      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      expect(cleanupCalls).toBe(2);
    });

    it("P5: accepts as a distinct user turn whose undo reverses the accepted draft", async () => {
      const { journal, lifecycle, store } = createDrizzleCollabPersistence(db);
      const liveCoordinator = createInMemoryCoordinator(journal);
      const domain = createFacade({
        journal,
        coordinator: liveCoordinator,
        lifecycle,
        store,
        hocuspocus: () => null,
        bindHocuspocus: (_instance: Hocuspocus) => {},
        draftStore,
        draftAcceptJournal: createDrizzleDraftAcceptJournal(db),
        liveLineage: createTurnLiveLineageReadModel({
          store: createDrizzleTurnLiveLineageStore(db),
          resolveDocumentUri: async (documentId) => documentId,
        }),
        threads: {
          async findById(id) {
            return id === THREAD_ID ? { userId: USER_ID, projectId: PROJECT_ID } : null;
          },
        },
        resolveWorkWriteMode: async () => "direct",
        createDraftSessionCore: ({ threadId }) =>
          createDrizzleDraftSessionCore({
            db,
            threadId,
            liveCoordinator,
            draftStore,
          }),
      });
      await lifecycle.ensureDocument(DOC_ID);
      liveCoordinator.ensureEmpty(DOC_ID);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await createCommittedDraft(db, liveCoordinator, draftStore, "distinct-event");
      await db.insert(turns).values({
        id: LATER_TURN_ID,
        threadId: THREAD_ID,
        parentTurnId: TURN_ID,
        role: "user",
        status: "complete",
      });
      await db
        .update(threads)
        .set({ activeLeafTurnId: LATER_TURN_ID })
        .where(eq(threads.id, THREAD_ID));

      const accept = await domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      });
      if (accept.status !== "applied") throw new Error("expected applied accept");

      const orderedTurns = await db
        .select()
        .from(turns)
        .where(eq(turns.threadId, THREAD_ID))
        .orderBy(asc(turns.createdAt));
      const acceptTurn = orderedTurns.find((turn) => turn.id === accept.acceptTurnId);
      expect(acceptTurn).toMatchObject({
        id: accept.acceptTurnId,
        role: "user",
        status: "complete",
        parentTurnId: LATER_TURN_ID,
      });
      const mutationRows = await db
        .select()
        .from(agentEditMutations)
        .where(eq(agentEditMutations.writeId, `draft-accept:${draft.id}`));
      expect(mutationRows).toMatchObject([
        { turnId: accept.acceptTurnId, createdSeq: accept.appliedUpdateSeq },
      ]);
      await expect(domain.listLiveDocumentsForTurn(THREAD_ID, TURN_ID)).resolves.toEqual([]);
      await expect(
        domain.listLiveDocumentsForTurn(THREAD_ID, accept.acceptTurnId),
      ).resolves.toEqual([{ documentId: DOC_ID, uri: DOC_ID }]);
      expect(await readMarkdown(domain, DOC_ID)).toContain("Draft distinct-event.");

      await expect(
        domain.reverseTurn({
          threadId: THREAD_ID,
          turnId: accept.acceptTurnId,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ status: "reversed" });
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Draft distinct-event.");
    });

    it("P6: silently accepts when live edits touched different blocks than the draft", async () => {
      const { domain, liveCoordinator, liveJournal } = createLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
      });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.\n\nBeta live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await writeDraftReplacement(
        domain,
        "response-disjoint",
        "Beta live.",
        "Beta draft.",
      );
      await replaceLiveText(liveCoordinator, liveJournal, "Alpha live.", "Alpha human.");

      await expect(
        domain.drafts.acceptDraft({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied" });

      const markdown = await readMarkdown(domain, DOC_ID);
      expect(markdown).toContain("Alpha human.");
      expect(markdown).toContain("Beta draft.");
    });

    it("P6: flags same-block live edits, then confirmed accept applies and remains undoable", async () => {
      const { domain, liveCoordinator, liveJournal } = createLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
      });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.\n\nBeta live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await writeDraftReplacement(
        domain,
        "response-overlap",
        "Beta live.",
        "Beta draft.",
      );
      await replaceLiveText(liveCoordinator, liveJournal, "Beta live.", "Beta human.");

      const overlap = await domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      });
      expect(overlap).toMatchObject({
        status: "overlap",
        draftId: expect.any(String),
        live: expect.stringContaining("Beta human."),
        preview: expect.stringContaining("Beta draft."),
      });
      expect(overlap.status === "overlap" ? overlap.overlappingBlocks : []).not.toHaveLength(0);
      expect(await readMarkdown(domain, DOC_ID)).toContain("Beta human.");

      await replaceLiveText(liveCoordinator, liveJournal, "Beta human.", "Beta later.");
      const staleConfirm = await domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        confirmOverlap: true,
        confirmedLiveRevisionToken: overlap.status === "overlap" ? overlap.liveRevisionToken : 0,
      });
      expect(staleConfirm).toMatchObject({
        status: "overlap",
        draftId: draft.id,
        live: expect.stringContaining("Beta later."),
        preview: expect.stringContaining("Beta draft."),
      });
      if (staleConfirm.status !== "overlap") throw new Error("expected refreshed overlap");

      const applied = await domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        confirmOverlap: true,
        confirmedLiveRevisionToken: staleConfirm.liveRevisionToken,
      });
      expect(applied).toMatchObject({ status: "applied" });
      if (applied.status !== "applied") throw new Error("expected applied accept");
      expect(await readMarkdown(domain, DOC_ID)).toContain("Beta draft.");

      const undo = await domain.reverseTurn({
        threadId: THREAD_ID,
        turnId: applied.acceptTurnId,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(["reversed", "reconciled", "partial"]).toContain(undo.status);
      expect(await readMarkdown(domain, DOC_ID)).toContain("Beta later.");
    });

    it("P6: a missed-overlap accept remains non-destructive and undoable", async () => {
      const { domain, liveCoordinator, liveJournal } = createLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
      });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.\n\nBeta live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await writeDraftReplacement(
        domain,
        "response-bounded",
        "Beta live.",
        "Beta draft.",
      );
      await replaceLiveText(liveCoordinator, liveJournal, "Beta live.", "Beta human.");

      const applied = await domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        confirmOverlap: true,
        confirmedLiveRevisionToken: await liveJournal.latestUpdateSeq(DOC_ID),
      });
      expect(applied).toMatchObject({ status: "applied" });
      if (applied.status !== "applied") throw new Error("expected applied accept");
      expect(await readMarkdown(domain, DOC_ID)).toContain("Beta draft.");

      await domain.reverseTurn({
        threadId: THREAD_ID,
        turnId: applied.acceptTurnId,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      const afterUndo = await readMarkdown(domain, DOC_ID);
      expect(afterUndo).toContain("Alpha live.");
      expect(afterUndo).toContain("Beta human.");
    });

    it("invalidates active draft response sessions before they can commit", async () => {
      const { domain } = createLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });

      await domain
        .agentEdit()
        .write(
          { command: "read", file: "chapter.md", documentId: DOC_ID },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-first-draft" },
        );
      await expect(
        domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "First draft." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-first-draft" },
          ),
      ).resolves.toMatchObject({ isError: false });
      await domain.finalizeResponseCommit("response-first-draft", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      expect(await draftStore.listUpdates(draft.id)).toHaveLength(1);

      await expect(
        domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Stale draft." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-stale-draft" },
          ),
      ).resolves.toMatchObject({ isError: false });

      await domain.drafts.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      });
      await expect(
        domain.finalizeResponseCommit("response-stale-draft", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toEqual({
        status: "draft_closed",
        responseId: "response-stale-draft",
        mode: "draft",
        documents: [],
        stagedCreates: { committed: [], discarded: [] },
      });
      expect(await readMarkdown(domain, DOC_ID)).toContain("First draft.");
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Stale draft.");
    });
  });
}

type LiveHarnessOptions = {
  aiWriteMode?: "direct" | "draft";
  documentWriteHook?: Parameters<typeof createFacade>[0]["documentWriteHook"];
  beforePreferenceRead?: () => Promise<void>;
  draftReviewLease?: ReturnType<typeof createDraftReviewLease>;
};

function createLiveHarness(
  db: Parameters<typeof createDrizzleDraftSessionCore>[0]["db"],
  draftStore: Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"],
  options: LiveHarnessOptions = {},
): {
  domain: ReturnType<typeof createFacade>;
  liveCoordinator: ReturnType<typeof createInMemoryCoordinator>;
  liveJournal: ReturnType<typeof createInMemoryJournal>;
} {
  const liveJournal = createInMemoryJournal();
  const liveCoordinator = createInMemoryCoordinator(liveJournal);
  return {
    domain: createFacade({
      journal: liveJournal,
      coordinator: liveCoordinator,
      lifecycle: createInMemoryDocumentLifecycle(liveCoordinator),
      store: storeFor(liveJournal),
      hocuspocus: () => null,
      bindHocuspocus: (_instance: Hocuspocus) => {},
      draftStore,
      draftReviewLease: options.draftReviewLease,
      draftAcceptJournal: createInMemoryDraftAcceptJournal(liveJournal),
      liveLineage: createTestLiveLineage(liveJournal),
      threads: {
        async findById(id) {
          await options.beforePreferenceRead?.();
          return id === THREAD_ID
            ? {
                userId: USER_ID,
                projectId: PROJECT_ID,
              }
            : null;
        },
      },
      resolveWorkWriteMode: async () => options.aiWriteMode ?? "direct",
      createDraftSessionCore: ({ threadId }) =>
        createDrizzleDraftSessionCore({
          db,
          threadId,
          liveCoordinator,
          draftStore,
          latestLiveUpdateSeq: latestLiveUpdateSeq(liveJournal),
          isDraftUnderReview: options.draftReviewLease?.isUnderReview,
        }),
      documentWriteHook: options.documentWriteHook,
    }),
    liveCoordinator,
    liveJournal,
  };
}

function createDrizzleLiveHarness(
  db: Database,
  draftStore: Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"],
  options: LiveHarnessOptions & {
    coordinatorFactory?: (
      base: ReturnType<typeof createInMemoryCoordinator>,
    ) => Parameters<typeof createFacade>[0]["coordinator"];
  } = {},
): {
  domain: ReturnType<typeof createFacade>;
  liveCoordinator: ReturnType<typeof createInMemoryCoordinator>;
  liveJournal: ReturnType<typeof createDrizzleCollabPersistence>["journal"];
  liveStore: ReturnType<typeof createDrizzleCollabPersistence>["store"];
} {
  const { journal, lifecycle, store } = createDrizzleCollabPersistence(db);
  const liveCoordinator = createInMemoryCoordinator(journal);
  const coordinator = options.coordinatorFactory?.(liveCoordinator) ?? liveCoordinator;
  return {
    domain: createFacade({
      journal,
      coordinator,
      lifecycle: {
        async ensureDocument(documentId) {
          await lifecycle.ensureDocument(documentId);
          liveCoordinator.ensureEmpty(documentId);
        },
      },
      store,
      hocuspocus: () => null,
      bindHocuspocus: (_instance: Hocuspocus) => {},
      draftStore,
      draftReviewLease: options.draftReviewLease,
      draftAcceptJournal: createDrizzleDraftAcceptJournal(db),
      liveLineage: createTurnLiveLineageReadModel({
        store: createDrizzleTurnLiveLineageStore(db),
        resolveDocumentUri: async (documentId) => documentId,
      }),
      threads: {
        async findById(id) {
          await options.beforePreferenceRead?.();
          return id === THREAD_ID
            ? {
                userId: USER_ID,
                projectId: PROJECT_ID,
              }
            : null;
        },
      },
      resolveWorkWriteMode: async () => options.aiWriteMode ?? "direct",
      createDraftSessionCore: ({ threadId }) =>
        createDrizzleDraftSessionCore({
          db,
          threadId,
          liveCoordinator: coordinator,
          draftStore,
          latestLiveUpdateSeq: store.latestUpdateSeq,
          isDraftUnderReview: options.draftReviewLease?.isUnderReview,
        }),
      documentWriteHook: options.documentWriteHook,
    }),
    liveCoordinator,
    liveJournal: journal,
    liveStore: store,
  };
}

function latestLiveUpdateSeq(liveJournal: ReturnType<typeof createInMemoryJournal>) {
  return async (documentId: DocumentId) => liveJournal.latestUpdateSeq(documentId);
}

async function writeDraftReplacement(
  domain: ReturnType<typeof createFacade>,
  responseId: string,
  find: string,
  content: string,
): Promise<{ id: string }> {
  await domain
    .agentEdit()
    .write(
      { command: "read", file: "chapter.md", documentId: DOC_ID },
      { threadId: THREAD_ID, turnId: TURN_ID, responseId },
    );
  await expect(
    domain.agentEdit().write(
      {
        command: "replace",
        file: "chapter.md",
        documentId: DOC_ID,
        find,
        content,
      },
      { threadId: THREAD_ID, turnId: TURN_ID, responseId },
    ),
  ).resolves.toMatchObject({ isError: false });
  await domain.finalizeResponseCommit(responseId, { threadId: THREAD_ID, turnId: TURN_ID });
  const draft = await domain.drafts.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
  if (!draft) throw new Error("expected active draft");
  return draft;
}

async function replaceLiveText(
  liveCoordinator: ReturnType<typeof createInMemoryCoordinator>,
  liveJournal: ReturnType<typeof createInMemoryJournal>,
  find: string,
  replacement: string,
): Promise<void> {
  const schema = buildDocumentSchema();
  const model = yProsemirrorModel(schema);
  let update: Uint8Array | null = null;

  await liveCoordinator.withDocument(DOC_ID, async (doc) => {
    const handle = toDocHandle(doc);
    const block = model
      .getBlocks(handle)
      .find((candidate) => model.getText(candidate).includes(find));
    if (!block) throw new Error(`Block not found for ${find}`);
    const text = model.getText(block);
    const from = text.indexOf(find);
    const before = Y.encodeStateVector(doc);
    model.transact(
      handle,
      () => model.applyTextEdit(handle, block, { from, to: from + find.length }, replacement),
      { type: "user", userId: USER_ID },
    );
    update = Y.encodeStateAsUpdate(doc, before);
  });

  if (!update) throw new Error("Expected live update");
  await liveJournal.append(DOC_ID, update, { origin: `human:${USER_ID}`, seq: 0 });
}

function storeFor(journal: ReturnType<typeof createInMemoryJournal>): CollabFacadeStore {
  return {
    createCheckpoint: (docId, state, reason, upToSeq) =>
      journal.createCheckpoint(docId, state, reason, upToSeq),
    getCheckpoint: (id) => journal.getCheckpoint(id),
    listCheckpoints: (docId) => journal.listCheckpoints(docId),
    latestUpdate: (docId) => journal.latestUpdate(docId),
    latestUpdateSeq: (docId) => journal.latestUpdateSeq(docId),
  };
}

function createTestLiveLineage(journal: ReturnType<typeof createInMemoryJournal>) {
  return {
    async listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId) {
      return (await journal.documentsForTurn(threadId, turnId)).map((documentId) => ({
        documentId: documentId as DocumentId,
        uri: documentId,
      }));
    },
  };
}

async function createCommittedDraft(
  db: Parameters<typeof createDrizzleDraftSessionCore>[0]["db"],
  liveCoordinator: Parameters<typeof createDrizzleDraftSessionCore>[0]["liveCoordinator"],
  draftStore: Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"],
  label: string,
  options: { latestLiveUpdateSeq?: (documentId: DocumentId) => Promise<number> } = {},
) {
  const draftCore = createDrizzleDraftSessionCore({
    db,
    threadId: THREAD_ID,
    liveCoordinator,
    draftStore,
    latestLiveUpdateSeq: options.latestLiveUpdateSeq,
  });
  await draftCore.write(
    { command: "read", file: "chapter.md", documentId: DOC_ID },
    { threadId: THREAD_ID, turnId: TURN_ID },
  );
  await draftCore.write(
    {
      command: "insert",
      file: "chapter.md",
      documentId: DOC_ID,
      content: `Draft ${label}.`,
    },
    { threadId: THREAD_ID, turnId: TURN_ID, responseId: `response-${label}` },
  );
  await draftCore.commitResponse(`response-${label}`);
  const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
  if (!draft) throw new Error("expected active draft");
  return draft;
}

async function expireClaim(
  db: Parameters<typeof createDrizzleDraftSessionCore>[0]["db"],
  documentYjsDrafts: typeof import("@meridian/database/schema").documentYjsDrafts,
  draftId: string,
) {
  await db
    .update(documentYjsDrafts)
    .set({ claimedAt: sql`now() - interval '11 minutes'` })
    .where(eq(documentYjsDrafts.id, draftId));
}

async function claimActiveForTest(
  db: Parameters<typeof createDrizzleDraftSessionCore>[0]["db"],
  documentYjsDrafts: typeof import("@meridian/database/schema").documentYjsDrafts,
  draftId: string,
) {
  const [draft] = await db
    .update(documentYjsDrafts)
    .set({
      claimedAt: sql`now()`,
      claimToken: TEST_CLAIM_TOKEN,
      updatedAt: sql`now()`,
    })
    .where(eq(documentYjsDrafts.id, draftId))
    .returning();
  return draft ?? null;
}

async function readMarkdown(domain: ReturnType<typeof createFacade>, documentId: DocumentId) {
  const read = await domain.readAsMarkdown(documentId);
  if (!read.ok) throw new Error(`read failed: ${read.error.code}`);
  return read.value;
}
