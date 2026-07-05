/** Integration proof for draft-scoped agent-edit response commits. */
import type { Hocuspocus } from "@hocuspocus/server";
import {
  createAgentEditCodec,
  type DocumentCoordinator,
  toDocHandle,
  type UpdateJournal,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createAgentEditResponseWriteLifecycle,
  createWiredCoreToolRegistrations,
} from "../../../lib/wired-core-tools.js";
import { handleWorkWriteModeRequest } from "../../../lib/work-write-mode-route.js";
import type { ContextPort } from "../../context/index.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createDrizzleDraftAcceptJournal } from "../adapters/drizzle-draft-accept-journal.js";
import {
  createDrizzleDraftAgentEditJournal,
  createDrizzleDraftSyncStateStore,
} from "../adapters/drizzle-draft-agent-edit.js";
import { createDrizzleDraftStore } from "../adapters/drizzle-drafts.js";
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
  createDrizzleDraftCommitDestination,
  createDrizzleDraftSessionCore,
  createFacade,
} from "../composition.js";
import { updateMarkdownProjection } from "../domain/document-activity.js";
import { buildStoredDraftProjection, serializePreview } from "../domain/draft-projection.js";
import { buildDraftReviewSnapshot } from "../domain/draft-review-snapshot.js";
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
const BLOCKER_TURNS = [
  "00000000-0000-4000-8000-000000000511",
  "00000000-0000-4000-8000-000000000512",
  "00000000-0000-4000-8000-000000000513",
  "00000000-0000-4000-8000-000000000514",
] as const satisfies readonly TurnId[];

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

    async function syncStateGenerations(draftId: string): Promise<number[]> {
      const rows = await db
        .select({ acceptGeneration: agentEditSyncState.acceptGeneration })
        .from(agentEditSyncState)
        .where(eq(agentEditSyncState.scopeId, draftId))
        .orderBy(asc(agentEditSyncState.acceptGeneration));
      return rows.map((row) => row.acceptGeneration);
    }

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
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: `response-created-${label}`,
            createdDocument: true,
          },
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
          const [row] = await db
            .select({ id: documents.id })
            .from(documents)
            .where(eq(documents.id, CREATED_DOC_ID))
            .limit(1);
          if (row) return { ok: true, value: { documentId: CREATED_DOC_ID, created: false } };
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

    function toolContext(responseId: string, turnId: TurnId = TURN_ID) {
      return {
        signal: new AbortController().signal,
        threadId: THREAD_ID,
        turnId,
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

    async function setWorkModeForTest(
      domain: ReturnType<typeof createFacade>,
      aiWriteMode: "direct" | "draft",
    ) {
      return handleWorkWriteModeRequest(
        {
          works: {
            async findById(workId) {
              const [row] = await db
                .select({
                  id: works.id,
                  createdByUserId: works.createdByUserId,
                  aiWriteMode: works.aiWriteMode,
                })
                .from(works)
                .where(eq(works.id, workId))
                .limit(1);
              return row ? { ...row, aiWriteMode: row.aiWriteMode as "direct" | "draft" } : null;
            },
            async updateWriteMode(workId, nextMode) {
              await db.update(works).set({ aiWriteMode: nextMode }).where(eq(works.id, workId));
            },
          },
          drafts: {
            listActiveDraftsByWork: (input) => draftStore.listActiveDraftsByWork(input),
            countInFlightDraftSessionsByWork:
              domain.draftSessionStats.countInFlightDraftSessionsByWork,
          },
        },
        { projectId: PROJECT_ID, workId: WORK_ID, userId: USER_ID, aiWriteMode },
      );
    }

    it("replays draft create overwrite as an exact full-document replacement", async () => {
      const { liveCoordinator, liveJournal } = createLiveHarness(db, draftStore);
      await seedLiveMarkdown(
        liveCoordinator,
        liveJournal,
        "Alpha live.\n\nBeta live.\n\nGamma live.",
      );
      const draftCore = createDrizzleDraftSessionCore({
        db,
        threadId: THREAD_ID,
        liveCoordinator,
        lifecycle: createInMemoryDocumentLifecycle(liveCoordinator),
        draftStore,
        latestLiveUpdateSeq: latestLiveUpdateSeq(liveJournal),
      });
      const replacement = "Delta draft.\n\nEpsilon draft.\n\nZeta draft.\n";

      await expect(
        draftCore.write(
          { command: "read", file: "chapter.md", documentId: DOC_ID },
          { threadId: THREAD_ID, turnId: TURN_ID },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        draftCore.write(
          {
            command: "create",
            file: "chapter.md",
            documentId: DOC_ID,
            content: replacement,
            overwrite: true,
          },
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-draft-overwrite-replace",
            createdDocument: false,
          },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        draftCore.commitResponse("response-draft-overwrite-replace"),
      ).resolves.toMatchObject({
        updateCount: 1,
      });

      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      const rows = await draftStore.listUpdates(draft.id);
      expect(rows.map((row) => row.updateKind ?? null)).toEqual(["replaceAll"]);
      const projected = await projectedDraftMarkdown(liveJournal, draftStore, draft);

      expect(projected).toBe(replacement);
      expect(projected).not.toContain("Alpha live");
      expect(projected).not.toContain("Beta live");
      expect(projected).not.toContain("Gamma live");
    });

    it("keeps draft move-flail overwrite projections to a single final copy", async () => {
      const { liveCoordinator, liveJournal } = createLiveHarness(db, draftStore);
      await seedLiveMarkdown(liveCoordinator, liveJournal, "Alpha.\n\nBeta.\n\nGamma.");
      const draftCore = createDrizzleDraftSessionCore({
        db,
        threadId: THREAD_ID,
        liveCoordinator,
        lifecycle: createInMemoryDocumentLifecycle(liveCoordinator),
        draftStore,
        latestLiveUpdateSeq: latestLiveUpdateSeq(liveJournal),
      });
      const finalMarkdown = "Third final.\n\nSecond final.\n\nFirst final.\n";

      await draftCore.write(
        { command: "read", file: "chapter.md", documentId: DOC_ID },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );
      await expect(
        draftCore.write(
          {
            command: "replace",
            file: "chapter.md",
            documentId: DOC_ID,
            find: "Beta",
            content: "Beta interim",
          },
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-draft-move-flail",
          },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        draftCore.write(
          {
            command: "create",
            file: "chapter.md",
            documentId: DOC_ID,
            content: finalMarkdown,
            overwrite: true,
          },
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-draft-move-flail",
            createdDocument: false,
          },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(draftCore.commitResponse("response-draft-move-flail")).resolves.toMatchObject({
        updateCount: 2,
      });

      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      const rows = await draftStore.listUpdates(draft.id);
      expect(rows.map((row) => row.updateKind ?? null)).toEqual([null, "replaceAll"]);
      const projected = await projectedDraftMarkdown(liveJournal, draftStore, draft);

      expect(projected).toBe(finalMarkdown);
      expect(projected.match(/final\./g)).toHaveLength(3);
      expect(projected).not.toContain("Alpha.");
      expect(projected).not.toContain("Beta.");
      expect(projected).not.toContain("Gamma.");
      expect(projected).not.toContain("Beta interim");
    });

    it("accepts gen-0 move-flail overwrite drafts into a single-copy live document", async () => {
      const { domain } = createLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha.\n\nBeta.\n\nGamma.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const finalMarkdown = "Alpha.\n\nGamma.\n\nBeta-revised.\n";

      await writeMoveFlailDraft(domain, {
        responseId: "response-accept-move-flail",
        finalMarkdown,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      expect((await draftStore.listUpdates(draft.id)).map((row) => row.updateKind ?? null)).toEqual(
        [null, "replaceAll"],
      );

      await expect(
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });

      const live = await readMarkdown(domain, DOC_ID);
      expect(live).toBe(finalMarkdown);
      expect(live.match(/Alpha\.|Gamma\.|Beta-revised\./g)).toHaveLength(3);
      expect(live).not.toContain("Beta interim");
      expect(live).not.toContain("Beta.\n");
    });

    it("partial-accepts a gen-0 overwrite operation into a single-copy live document", async () => {
      const { domain } = createLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha.\n\nBeta.\n\nGamma.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const finalMarkdown = "Alpha.\n\nGamma.\n\nBeta-revised.\n";

      await writeMoveFlailDraft(domain, {
        responseId: "response-partial-accept-overwrite",
        finalMarkdown,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      const rows = await draftStore.listUpdates(draft.id);
      const overwrite = rows.find((row) => row.updateKind === "replaceAll");
      if (!overwrite) throw new Error("expected overwrite row");
      const preview = await domain.draftReview.preview({ documentId: DOC_ID, draftId: draft.id });
      if (preview.status !== "active") throw new Error("expected active preview");
      const overwriteOperation = preview.operations?.find((operation) =>
        operation.sourceUpdateIds.includes(overwrite.id),
      );
      if (!overwriteOperation) throw new Error("expected overwrite operation");

      const partialAccept = await domain.draftReview.accept({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        operationIds: [overwriteOperation.operationId],
      });
      await expect(
        partialAccept.status === "closure_confirmation_required"
          ? domain.draftReview.accept({
              documentId: DOC_ID,
              threadId: THREAD_ID,
              draftId: draft.id,
              userId: USER_ID,
              operationIds: partialAccept.closureOperationIds,
              confirmedClosureOperationIds: partialAccept.closureOperationIds,
            })
          : Promise.resolve(partialAccept),
      ).resolves.toMatchObject({ status: "partial_applied", draftId: draft.id });

      const live = await readMarkdown(domain, DOC_ID);
      expect(live).toBe(finalMarkdown);
      expect(live.match(/Alpha\.|Gamma\.|Beta-revised\./g)).toHaveLength(3);
      expect(live).not.toContain("Beta interim");
      expect(live).not.toContain("Beta.\n");
    });

    it("accepts a simple gen-0 draft without changing the observable live result", async () => {
      const { domain } = createLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });

      await expect(
        domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Draft Beta." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-simple-gen0" },
          ),
      ).resolves.toMatchObject({ isError: false });
      await domain.finalizeResponseCommit("response-simple-gen0", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      await expect(
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });

      const live = await readMarkdown(domain, DOC_ID);
      expect(live).toContain("Alpha live.");
      expect(live).toContain("Draft Beta.");
      expect(live.match(/Draft Beta\./g)).toHaveLength(1);
    });

    it("accepts and undo-reactivates create overwrite without duplicating live or draft projection", async () => {
      const { domain, liveJournal } = createLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.\n\nBeta live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const replacement = "Overwrite one.\n\nOverwrite two.\n";

      await expect(
        domain
          .agentEdit()
          .write(
            { command: "read", file: "chapter.md", documentId: DOC_ID },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-accept-overwrite" },
          ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        domain.agentEdit().write(
          {
            command: "create",
            file: "chapter.md",
            documentId: DOC_ID,
            content: replacement,
            overwrite: true,
          },
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-accept-overwrite",
            createdDocument: false,
          },
        ),
      ).resolves.toMatchObject({ isError: false });
      await domain.finalizeResponseCommit("response-accept-overwrite", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });

      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      expect((await draftStore.listUpdates(draft.id)).map((row) => row.updateKind ?? null)).toEqual(
        ["replaceAll"],
      );

      await expect(
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      expect(await readMarkdown(domain, DOC_ID)).toBe(replacement);

      await expect(
        domain.draftReview.undoAccept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "reactivated", draftId: draft.id });
      expect(await readMarkdown(domain, DOC_ID)).toBe("Alpha live.\n\nBeta live.\n");

      const reactivated = await draftStore.getActiveDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
      });
      if (!reactivated) throw new Error("expected reactivated draft");
      expect(await projectedDraftMarkdown(liveJournal, draftStore, reactivated)).toBe(replacement);
    });

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
        lifecycle: createInMemoryDocumentLifecycle(liveCoordinator),
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
        domain.draftReview.accept({
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
        lifecycle: createInMemoryDocumentLifecycle(liveCoordinator),
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

      await domain.draftReview.accept({
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

    it("redirects a direct-start response to a draft commit after a mid-turn mode flip", async () => {
      let mode: "direct" | "draft" = "direct";
      const { domain } = createLiveHarness(db, draftStore, { aiWriteMode: () => mode });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.\n",
        origin: { type: "user", actorUserId: USER_ID },
      });

      await expect(
        domain
          .agentEdit()
          .write(
            { command: "read", file: "chapter.md", documentId: DOC_ID },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-lazy-draft" },
          ),
      ).resolves.toMatchObject({ isError: false, text: expect.stringContaining("Alpha live.") });
      await expect(
        domain.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Draft Beta.",
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-lazy-draft" },
        ),
      ).resolves.toMatchObject({ isError: false });

      mode = "draft";
      await expect(
        domain
          .agentEdit()
          .write(
            { command: "read", file: "chapter.md", documentId: DOC_ID },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-lazy-draft" },
          ),
      ).resolves.toMatchObject({
        isError: false,
        text: expect.stringContaining("Draft Beta."),
      });

      await expect(
        domain.finalizeResponseCommit("response-lazy-draft", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toEqual({
        status: "committed",
        documents: [{ documentId: DOC_ID, updateCount: 1 }],
        stagedCreates: { committed: [], discarded: [] },
      });
      expect(await readMarkdown(domain, DOC_ID)).toBe("Alpha live.\n");

      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      expect(draft).toMatchObject({ status: "active", lastActorTurnId: TURN_ID });
      if (!draft) throw new Error("expected active draft");
      await expect(
        domain.draftReview.preview({ documentId: DOC_ID, draftId: draft.id }),
      ).resolves.toMatchObject({ markdown: expect.stringContaining("Draft Beta.") });

      const undo = await domain
        .agentEdit()
        .write(
          { command: "undo", file: "chapter.md", documentId: DOC_ID },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-live-undo" },
        );
      expect(undo.text).not.toContain("not supported for draft-scoped edits");
      const redo = await domain
        .agentEdit()
        .write(
          { command: "redo", file: "chapter.md", documentId: DOC_ID },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-live-redo" },
        );
      expect(redo.text).not.toContain("not supported for draft-scoped edits");

      await expect(
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      expect(await readMarkdown(domain, DOC_ID)).toContain("Draft Beta.");
    });

    it("allows draft-to-direct while redirected draft mode has no material state, then blocks after append", async () => {
      let mode: "direct" | "draft" = "draft";
      const { domain } = createLiveHarness(db, draftStore, { aiWriteMode: () => mode });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      await expect(
        domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Draft Beta." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-guard-lazy" },
          ),
      ).resolves.toMatchObject({ isError: false });
      expect(domain.draftSessionStats.countInFlightDraftSessionsByWork({ workId: WORK_ID })).toBe(
        0,
      );

      await expect(setWorkModeForTest(domain, "direct")).resolves.toMatchObject({
        status: "updated",
      });
      mode = "draft";
      await db.update(works).set({ aiWriteMode: "draft" }).where(eq(works.id, WORK_ID));
      await domain.finalizeResponseRollback("response-guard-lazy");

      await domain
        .agentEdit()
        .write(
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Draft Gamma." },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-guard-material" },
        );
      await domain.finalizeResponseCommit("response-guard-material", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      await expect(setWorkModeForTest(domain, "direct")).resolves.toMatchObject({
        status: "rejected",
        reason: "active_drafts",
        activeDraftCount: 1,
      });
    });

    it("rolls back a redirected draft session when the work flips back to direct before commit", async () => {
      let mode: "direct" | "draft" = "draft";
      const { domain } = createLiveHarness(db, draftStore, { aiWriteMode: () => mode });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      await expect(
        domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Draft Beta." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-direct-fence" },
          ),
      ).resolves.toMatchObject({ isError: false });

      mode = "direct";
      await expect(
        domain.finalizeResponseCommit("response-direct-fence", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "draft_closed" });
      expect(await readMarkdown(domain, DOC_ID)).toBe("Alpha live.\n");
      expect(
        await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID }),
      ).toBeNull();
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
        domain.draftReview.accept({
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

    it("keeps existing-document overwrite creates marked as non-created across later turns", async () => {
      const { domain, liveStore } = createDrizzleLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
      });
      await insertCreatedDocumentRow(db, "existing-overwrite");
      await domain.writeDocument({
        documentId: CREATED_DOC_ID,
        threadId: THREAD_ID,
        markdown: "Existing live content.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const preExistingContentSeq = await liveStore.latestUpdateSeq(CREATED_DOC_ID);
      await db.insert(turns).values({
        id: LATER_TURN_ID,
        threadId: THREAD_ID,
        parentTurnId: TURN_ID,
        role: "assistant",
        status: "complete",
      });
      const { write, responseWrites } = wiredWriteForCreatedDocument(db, domain);

      for (const [responseId, content, turnId] of [
        ["response-existing-create-1", "Draft overwrite one.", TURN_ID],
        ["response-existing-create-2", "Draft overwrite two.", LATER_TURN_ID],
      ] as const) {
        await expect(
          write(
            { command: "create", path: "existing-overwrite.md", content, overwrite: true },
            toolContext(responseId, turnId),
          ),
        ).resolves.toMatchObject({ metadata: { documentId: CREATED_DOC_ID } });
        await expect(
          responseWrites.commitResponse(responseId, { threadId: THREAD_ID, turnId }),
        ).resolves.toEqual({ status: "committed", concurrentEdits: [] });
      }

      const draft = await draftStore.getActiveDraft({
        documentId: CREATED_DOC_ID,
        threadId: THREAD_ID,
      });
      expect(draft).toMatchObject({
        status: "active",
        createdDocument: false,
        lastActorTurnId: LATER_TURN_ID,
      });
      expect(draft ? await draftStore.listUpdates(draft.id) : []).toHaveLength(2);
      if (!draft) throw new Error("expected active existing-document draft");

      expect(draft.baseLiveUpdateSeq).toBe(preExistingContentSeq);
    });

    it("rejecting a created-document draft deletes the placeholder and all draft-scoped state", async () => {
      const { domain } = createDrizzleLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      const draft = await createCreatedDocumentDraft(db, domain, "reject");

      await expect(
        domain.draftReview.reject({
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
        domain.draftReview.accept({
          documentId: CREATED_DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });

      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "applied" });
      expect(await createdDocumentRowCount()).toBe(1);
      await expect(readMarkdown(domain, CREATED_DOC_ID)).resolves.toContain(
        "Created draft content accept.",
      );
    });

    it("compensates a failed created-document response commit by deleting the active draft and placeholder", async () => {
      let failProjection = false;
      const failingDraftStore = {
        ...draftStore,
        async listUpdates(draftId: string) {
          if (failProjection) throw new Error("simulated projection failure after journal commit");
          return draftStore.listUpdates(draftId);
        },
      };
      const failing = createDrizzleLiveHarness(db, failingDraftStore, {
        aiWriteMode: "draft",
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
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-created-fail",
            createdDocument: true,
          },
        ),
      ).resolves.toMatchObject({ isError: false });
      failProjection = true;

      await expect(
        failing.domain.finalizeResponseCommit("response-created-fail", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "committed" });

      expect(await createdDocumentRowCount()).toBe(1);
      expect(await createdDocumentDraftRowCount()).toBe(1);
      expect(await failing.domain.draftReview.list({ threadId: THREAD_ID })).toHaveLength(1);
    });

    it("does not delete another response's created-document draft during failed-response cleanup", async () => {
      let failProjection = false;
      const failingDraftStore = {
        ...draftStore,
        async listUpdates(draftId: string) {
          if (failProjection) throw new Error("simulated projection failure after journal commit");
          return draftStore.listUpdates(draftId);
        },
      };
      const failing = createDrizzleLiveHarness(db, failingDraftStore, {
        aiWriteMode: "draft",
      });

      await insertCreatedDocumentRow(db, "shared-created");
      await expect(
        failing.domain.agentEdit().write(
          {
            command: "create",
            file: "shared-created.md",
            documentId: CREATED_DOC_ID,
            content: "Legitimate created draft.",
          },
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-created-owner",
            createdDocument: true,
          },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        failing.domain.finalizeResponseCommit("response-created-owner", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "committed" });
      const draft = await draftStore.getActiveDraft({
        documentId: CREATED_DOC_ID,
        threadId: THREAD_ID,
      });
      if (!draft) throw new Error("expected active created-document draft");

      await expect(
        failing.domain.agentEdit().write(
          {
            command: "insert",
            file: "shared-created.md",
            documentId: CREATED_DOC_ID,
            content: "Failed response append.",
          },
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-created-fail-later",
            createdDocument: true,
          },
        ),
      ).resolves.toMatchObject({ isError: false });
      failProjection = true;

      await expect(
        failing.domain.finalizeResponseCommit("response-created-fail-later", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "committed" });

      expect(await createdDocumentRowCount()).toBe(1);
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({
        status: "active",
        createdDocument: true,
      });
      expect(await draftStore.listUpdates(draft.id)).toHaveLength(2);
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
        domain.draftReview.accept({
          documentId: CREATED_DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).rejects.toThrow("Document not found");
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
        lifecycle: createInMemoryDocumentLifecycle(liveCoordinator),
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
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
        domain.draftReview.reject({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id }),
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
        domain.draftReview.reject({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id }),
      ).resolves.toEqual({
        status: "discarded",
        draftId: draft.id,
      });

      await expect(
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toEqual({ status: "not_found" });
      const mutationRows = await db
        .select({ writeId: agentEditMutations.writeId })
        .from(agentEditMutations)
        .where(eq(agentEditMutations.writeId, `draft-accept:${draft.id}:0`));
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
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });

      await expect(
        domain.draftReview.accept({
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
          .filter((mutation) => mutation.writeId === `draft-accept:${draft.id}:0`),
      ).toHaveLength(1);
    });

    it("opens a fresh draft response after work-scoped invalidation without treating it as stale", async () => {
      const { domain } = createLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
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

      await expect(
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied" });

      await expect(
        domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Fresh draft." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-fresh-draft" },
          ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        domain.finalizeResponseCommit("response-fresh-draft", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "committed" });
      await expect(
        domain.draftReview.preview({
          documentId: DOC_ID,
          draftId:
            (await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID }))?.id ??
            "missing",
        }),
      ).resolves.toMatchObject({ markdown: expect.stringContaining("Fresh draft.") });
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
      await domain.draftReview.accept({
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

      await domain.draftReview.accept({
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
        lifecycle: createInMemoryDocumentLifecycle(liveCoordinator),
        draftStore,
      });

      await staleCore.write(
        { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Stale append." },
        { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-append-fence" },
      );
      await expect(
        domain.draftReview.reject({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id }),
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

    it("B2: agent writes append to an already-open draft review and stale reviewed tokens are fenced", async () => {
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
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "First draft." },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-create-draft" },
        );
      await domain.finalizeResponseCommit("response-create-draft", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      const reviewed = await domain.draftReview.preview({
        documentId: DOC_ID,
        draftId: draft.id,
      });
      if (reviewed.status !== "active") throw new Error("expected active draft preview");
      expect(reviewed).toMatchObject({
        draftRevisionToken: reviewed.draftRevisionToken,
        markdown: expect.stringContaining("First draft."),
      });

      await expect(
        domain.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Concurrent during review.",
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-during-review" },
        ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        domain.finalizeResponseCommit("response-during-review", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "committed" });

      expect((await draftStore.listUpdates(draft.id)).map((row) => row.actorTurnId)).toEqual([
        TURN_ID,
        TURN_ID,
      ]);
      const refreshed = await domain.draftReview.preview({
        documentId: DOC_ID,
        draftId: draft.id,
      });
      if (refreshed.status !== "active") throw new Error("expected active draft preview");
      expect(refreshed).toMatchObject({
        draftRevisionToken: refreshed.draftRevisionToken,
        markdown: expect.stringContaining("Concurrent during review."),
      });

      await expect(
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
          draftRevisionToken: reviewed.draftRevisionToken,
        }),
      ).resolves.toEqual({
        status: "stale_draft",
        draftId: draft.id,
        draftRevisionToken: refreshed.draftRevisionToken,
      });
    });

    it("B2: response commits that finish while the draft is being reviewed keep their updates", async () => {
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
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "First draft." },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-first" },
        );
      await domain.finalizeResponseCommit("response-first", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      await domain.draftReview.preview({
        documentId: DOC_ID,
        draftId: draft.id,
      });

      await expect(
        domain.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Committed mid-review.",
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-mid-review" },
        ),
      ).resolves.toMatchObject({ isError: false });

      await expect(
        domain.finalizeResponseCommit("response-mid-review", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toEqual({
        status: "committed",
        documents: [{ documentId: DOC_ID, updateCount: 1 }],
        stagedCreates: { committed: [], discarded: [] },
      });
      expect(await draftStore.listUpdates(draft.id)).toHaveLength(2);
      await expect(
        domain.draftReview.preview({ documentId: DOC_ID, draftId: draft.id }),
      ).resolves.toMatchObject({ markdown: expect.stringContaining("Committed mid-review.") });
    });

    it("B3: applied retry recovers live doc after journal append succeeds but live apply crashes", async () => {
      let failNextApply = false;
      const { domain, liveCoordinator, liveStore } = createDrizzleLiveHarness(db, draftStore, {
        coordinatorFactory(base) {
          return {
            withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
              if (failNextApply) {
                failNextApply = false;
                throw new Error("simulated crash after finishing accept");
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
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
          confirmOverlap: true,
          confirmedLiveRevisionToken: await liveStore.latestUpdateSeq(DOC_ID),
        }),
      ).rejects.toThrow("simulated crash after finishing accept");
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "active" });
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Draft recovery.");

      const retry = createDrizzleLiveHarness(db, draftStore);
      await expect(
        retry.domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      expect(await readMarkdown(retry.domain, DOC_ID)).toContain("Draft recovery.");
    });

    it("keeps draft sync-state baselines scoped to the current accept generation", async () => {
      const { domain } = createDrizzleLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Seed live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      await expect(
        domain
          .agentEdit()
          .write(
            { command: "read", file: "chapter.md", documentId: DOC_ID },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-generation-0" },
          ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "First draft." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-generation-0" },
          ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        domain.finalizeResponseCommit("response-generation-0", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        }),
      ).resolves.toMatchObject({ status: "committed" });
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      await expect(syncStateGenerations(draft.id)).resolves.toEqual([]);

      const beforeApply = await domain.draftReview.preview({
        documentId: DOC_ID,
        draftId: draft.id,
      });
      if (beforeApply.status !== "active") throw new Error("expected active draft preview");
      await expect(
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
          draftRevisionToken: beforeApply.draftRevisionToken,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      await expect(
        domain.draftReview.undoAccept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "reactivated", draftId: draft.id });

      await db.insert(agentEditSyncState).values({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        scopeId: draft.id,
        stateVector: Buffer.from([1]),
        syncedSnapshot: Buffer.from([2]),
        committedSnapshot: Buffer.from([3]),
        acceptGeneration: 0,
      });
      const syncStateStore = createDrizzleDraftSyncStateStore(db, { draftStore });
      await expect(syncStateStore.load(DOC_ID, THREAD_ID)).resolves.toBeNull();
      await expect(syncStateGenerations(draft.id)).resolves.toEqual([0]);

      const restarted = createDrizzleLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await expect(
        restarted.domain
          .agentEdit()
          .write(
            { command: "read", file: "chapter.md", documentId: DOC_ID },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-generation-1" },
          ),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        restarted.domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Second draft." },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-generation-1" },
          ),
      ).resolves.toMatchObject({ isError: false });
      await vi.waitFor(async () => {
        await expect(syncStateGenerations(draft.id)).resolves.toEqual([1]);
      });
      await expect(syncStateStore.load(DOC_ID, THREAD_ID)).resolves.toMatchObject({
        stateVector: expect.any(Uint8Array),
        syncedSnapshot: expect.any(Uint8Array),
        committedSnapshot: expect.any(Uint8Array),
      });
    });

    it("draft turn redo faithfully restores the original review model", async () => {
      const { domain, liveCoordinator, liveJournal, liveStore } = createDrizzleLiveHarness(
        db,
        draftStore,
        {
          aiWriteMode: "draft",
        },
      );
      await seedLiveMarkdown(liveCoordinator, liveJournal, "Alpha live.\n\nBeta live.");
      const draft = await writeDraftReplacement(
        domain,
        "response-draft-redo-fidelity",
        "Beta live.",
        "Beta live before dawn while silver birds circled slowly above the silent courtyard.",
      );

      const beforeUndo = await reviewModel(liveJournal, draftStore, liveStore, draft.id);
      const draftJournal = createDrizzleDraftAgentEditJournal(db, {
        threadId: THREAD_ID,
        liveUpdateJournal: liveJournal,
        draftStore,
        latestLiveUpdateSeq: liveStore.latestUpdateSeq,
      });
      expect(beforeUndo.operations).toHaveLength(1);
      expect(beforeUndo.wordsAdded).toBeGreaterThan(0);

      const undoRecord = {
        documentId: DOC_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        writeIds: ["w1"],
        status: "reversed" as const,
        undoUpdateSeq: 0,
        reversedAt: new Date(),
        reversedByUserId: USER_ID,
      };
      await draftJournal.persistUndo(
        DOC_ID,
        await draftUpdateToMarkdown(liveJournal, draftStore, liveStore, draft.id, beforeUndo.live),
        [undoRecord],
        { type: "user", userId: USER_ID },
      );
      expect(await reviewModel(liveJournal, draftStore, liveStore, draft.id)).toMatchObject({
        operations: [],
        hunks: [],
        wordsAdded: 0,
        wordsRemoved: 0,
      });

      const redo = await draftJournal.persistRedo(
        DOC_ID,
        await draftUpdateToMarkdown(
          liveJournal,
          draftStore,
          liveStore,
          draft.id,
          beforeUndo.markdown,
        ),
        { threadId: THREAD_ID, undoUpdateSeq: undoRecord.undoUpdateSeq },
        { origin: `agent:${TURN_ID}`, actorTurnId: TURN_ID, seq: 0 },
      );
      expect(redo.consumed).toBe(true);

      expect(await reviewModel(liveJournal, draftStore, liveStore, draft.id)).toEqual(beforeUndo);
    });

    it("preserves original row attribution after apply, undo, and a later staged append", async () => {
      const { domain } = createDrizzleLiveHarness(db, draftStore, { aiWriteMode: "draft" });
      await db.insert(turns).values(
        BLOCKER_TURNS.map((id, index) => ({
          id,
          threadId: THREAD_ID,
          parentTurnId: index === 0 ? TURN_ID : BLOCKER_TURNS[index - 1],
          role: "assistant" as const,
          status: "complete" as const,
        })),
      );
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Seed live.",
        origin: { type: "user", actorUserId: USER_ID },
      });

      const blockerInserts = [
        "The silver bell sat on the sill.",
        "The blue lantern swung below the eaves.",
        "The red kite tugged at its string.",
      ] as const;
      for (const [index, content] of blockerInserts.entries()) {
        await appendDraftInsert(
          domain,
          `response-blocker-${index + 1}`,
          BLOCKER_TURNS[index],
          content,
        );
      }

      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      const beforeApply = await domain.draftReview.preview({
        documentId: DOC_ID,
        draftId: draft.id,
      });
      if (beforeApply.status !== "active") throw new Error("expected active draft preview");
      await expect(
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
          draftRevisionToken: beforeApply.draftRevisionToken,
        }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      await expect(
        domain.draftReview.undoAccept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).resolves.toMatchObject({ status: "reactivated", draftId: draft.id });

      await appendDraftInsert(
        domain,
        "response-blocker-4",
        BLOCKER_TURNS[3],
        "The green feather drifted under the gate.",
      );

      const rows = await draftStore.listUpdates(draft.id);
      expect(rows).toHaveLength(4);
      const afterAppend = await domain.draftReview.preview({
        documentId: DOC_ID,
        draftId: draft.id,
      });
      if (afterAppend.status !== "active") throw new Error("expected active draft preview");
      expect(afterAppend.operations).toBeDefined();
      const representedSourceRows = new Set(
        afterAppend.operations?.flatMap((operation) => operation.sourceUpdateIds) ?? [],
      );
      const representedRejectRows = new Set(
        afterAppend.operations?.flatMap((operation) => operation.rejectSourceUpdateIds) ?? [],
      );
      expect(representedSourceRows.size).toBeGreaterThan(0);
      expect(representedRejectRows.size).toBeGreaterThan(0);
      expect(rows.at(-1)?.id).toSatisfy((rowId: number | undefined) =>
        rowId === undefined ? false : representedSourceRows.has(rowId),
      );
    });

    it("B3: partial retry recovers live doc after journal append succeeds but live apply crashes", async () => {
      let failCountdown = 0;
      const { domain, liveStore } = createDrizzleLiveHarness(db, draftStore, {
        aiWriteMode: "draft",
        coordinatorFactory(base) {
          return {
            withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
              if (failCountdown > 0) {
                failCountdown -= 1;
                if (failCountdown === 0) throw new Error("simulated partial live apply crash");
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
      for (const [label, content] of [
        ["alpha", "Partial Alpha."],
        ["beta", "Partial Beta."],
      ] as const) {
        await expect(
          domain
            .agentEdit()
            .write(
              { command: "read", file: "chapter.md", documentId: DOC_ID },
              { threadId: THREAD_ID, turnId: TURN_ID, responseId: `response-partial-${label}` },
            ),
        ).resolves.toMatchObject({ isError: false });
        const insert = await domain
          .agentEdit()
          .write(
            { command: "insert", file: "chapter.md", documentId: DOC_ID, content },
            { threadId: THREAD_ID, turnId: TURN_ID, responseId: `response-partial-${label}` },
          );
        if (insert.isError) throw new Error(insert.text);
        await domain.finalizeResponseCommit(`response-partial-${label}`, {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        });
      }
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");
      const preview = await domain.draftReview.preview({ documentId: DOC_ID, draftId: draft.id });
      if (preview.status !== "active") throw new Error("expected active draft preview");
      const partialRows = await draftStore.listUpdates(draft.id);
      const alphaRow = partialRows[0];
      if (!alphaRow) throw new Error("expected Partial Alpha row");
      const alpha =
        preview.operations?.find(
          (operation) =>
            operation.sourceUpdateIds.includes(alphaRow.id) ||
            operation.afterExcerpt?.includes("Partial Alpha"),
        ) ?? preview.operations?.find((operation) => operation.sourceUpdateIds.length > 0);
      if (!alpha) throw new Error("expected operation for Partial Alpha row/content");
      const request = {
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        operationIds: [alpha.operationId],
        draftRevisionToken: preview.draftRevisionToken,
        confirmedClosureOperationIds: [alpha.operationId],
        confirmedLiveRevisionToken: await liveStore.latestUpdateSeq(DOC_ID),
        confirmOverlap: true,
      };

      failCountdown = 2;
      await expect(domain.draftReview.accept(request)).rejects.toThrow(
        "simulated partial live apply crash",
      );
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Partial Alpha.");

      const retry = createDrizzleLiveHarness(db, draftStore);
      await expect(retry.domain.draftReview.accept(request)).resolves.toMatchObject({
        status: "partial_applied",
        draftId: draft.id,
      });
      expect(await readMarkdown(retry.domain, DOC_ID)).toContain("Partial Alpha.");
    });

    it("SF6: concurrent second accept reports in_progress instead of not_found", async () => {
      let releaseFirstAccept!: () => void;
      const firstAcceptBlocked = new Promise<void>((resolve) => {
        const release = new Promise<void>((releaseResolve) => {
          releaseFirstAccept = releaseResolve;
        });
        const baseClaimMutation = draftStore.claimMutation.bind(draftStore);
        draftStore = {
          ...draftStore,
          async claimMutation(input) {
            const result = await baseClaimMutation(input);
            if (input.kind === "accept" && result.status === "claimed") {
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

      const firstAccept = domain.draftReview.accept({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      });
      await firstAcceptBlocked;
      await expect(
        domain.draftReview.accept({
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
        lifecycle: createInMemoryDocumentLifecycle(liveCoordinator),
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
        domain.draftReview.accept({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          draftId: draft.id,
          userId: USER_ID,
        }),
      ).rejects.toThrow("cleanup failed once");
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "applied" });
      await expect(
        domain.draftReview.accept({
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
            lifecycle: {
              async ensureDocument(documentId) {
                await lifecycle.ensureDocument(documentId);
                liveCoordinator.ensureEmpty(documentId);
              },
            },
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

      const accept = await domain.draftReview.accept({
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
      expect(orderedTurns.map((turn) => turn.id)).not.toContain(`draft-accept:${draft.id}:0`);
      const [threadAfterAccept] = await db
        .select({ activeLeafTurnId: threads.activeLeafTurnId })
        .from(threads)
        .where(eq(threads.id, THREAD_ID));
      expect(threadAfterAccept?.activeLeafTurnId).toBe(LATER_TURN_ID);
      const mutationRows = await db
        .select()
        .from(agentEditMutations)
        .where(eq(agentEditMutations.writeId, `draft-accept:${draft.id}:0`));
      expect(mutationRows).toMatchObject([
        { turnId: TURN_ID, createdSeq: accept.appliedUpdateSeq },
      ]);
      await expect(domain.listLiveDocumentsForTurn(THREAD_ID, TURN_ID)).resolves.toEqual([
        { documentId: DOC_ID, uri: DOC_ID, scope: "live" },
      ]);
      expect(await readMarkdown(domain, DOC_ID)).toContain("Draft distinct-event.");

      await expect(
        domain.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ status: "reversed" });
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Draft distinct-event.");
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "active" });
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
        domain.draftReview.accept({
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

      const overlap = await domain.draftReview.accept({
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
      const staleConfirm = await domain.draftReview.accept({
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

      const applied = await domain.draftReview.accept({
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

      const undo = await domain.agentEdit().reverse({
        docId: DOC_ID,
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "single", to: `draft-accept:${draft.id}:0` },
        actor: { type: "user", userId: USER_ID },
      });
      expect(undo.status === "reversed" || undo.status === "reconciled").toBe(true);
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

      const applied = await domain.draftReview.accept({
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

      await domain.agentEdit().reverse({
        docId: DOC_ID,
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "single", to: `draft-accept:${draft.id}:0` },
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

      await domain.draftReview.accept({
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
  aiWriteMode?: "direct" | "draft" | (() => "direct" | "draft");
  documentWriteHook?: Parameters<typeof createFacade>[0]["documentWriteHook"];
  beforePreferenceRead?: () => Promise<void>;
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
  const lifecycle = createInMemoryDocumentLifecycle(liveCoordinator);
  return {
    domain: createFacade({
      journal: liveJournal,
      coordinator: liveCoordinator,
      lifecycle,
      store: storeFor(liveJournal),
      hocuspocus: () => null,
      bindHocuspocus: (_instance: Hocuspocus) => {},
      draftStore,
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
      resolveWorkWriteMode: async () => {
        await options.beforePreferenceRead?.();
        return typeof options.aiWriteMode === "function"
          ? options.aiWriteMode()
          : (options.aiWriteMode ?? "direct");
      },
      createDraftSessionCore: ({ threadId }) =>
        createDrizzleDraftSessionCore({
          db,
          threadId,
          liveCoordinator,
          lifecycle,
          draftStore,
          latestLiveUpdateSeq: latestLiveUpdateSeq(liveJournal),
        }),
      createDraftCommitDestination: ({ threadId, draftFence }) =>
        createDrizzleDraftCommitDestination({
          db,
          threadId,
          draftFence,
          latestLiveUpdateSeq: latestLiveUpdateSeq(liveJournal),
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
  const { journal, lifecycle: dbLifecycle, store } = createDrizzleCollabPersistence(db);
  const liveCoordinator = createInMemoryCoordinator(journal);
  const baseCoordinator = options.coordinatorFactory?.(liveCoordinator) ?? liveCoordinator;
  const coordinator: DocumentCoordinator = {
    async withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
      try {
        return await baseCoordinator.withDocument(documentId, fn);
      } catch (cause) {
        if (!(cause instanceof Error) || cause.name !== "DocumentNotFoundError") throw cause;
        await baseCoordinator.recover(documentId);
        return baseCoordinator.withDocument(documentId, fn);
      }
    },
    recover: (documentId: string) => baseCoordinator.recover(documentId),
  };
  const lifecycle = {
    async ensureDocument(documentId: string) {
      await dbLifecycle.ensureDocument(documentId);
      liveCoordinator.ensureEmpty(documentId);
    },
  };
  return {
    domain: createFacade({
      journal,
      coordinator,
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
          await options.beforePreferenceRead?.();
          return id === THREAD_ID
            ? {
                userId: USER_ID,
                projectId: PROJECT_ID,
              }
            : null;
        },
      },
      resolveWorkWriteMode: async () => {
        await options.beforePreferenceRead?.();
        return typeof options.aiWriteMode === "function"
          ? options.aiWriteMode()
          : (options.aiWriteMode ?? "direct");
      },
      createDraftSessionCore: ({ threadId }) =>
        createDrizzleDraftSessionCore({
          db,
          threadId,
          liveCoordinator: coordinator,
          lifecycle,
          draftStore,
          latestLiveUpdateSeq: store.latestUpdateSeq,
        }),
      createDraftCommitDestination: ({ threadId, draftFence }) =>
        createDrizzleDraftCommitDestination({
          db,
          threadId,
          draftFence,
          latestLiveUpdateSeq: store.latestUpdateSeq,
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

async function writeMoveFlailDraft(
  domain: ReturnType<typeof createFacade>,
  input: { responseId: string; finalMarkdown: string },
): Promise<void> {
  await expect(
    domain
      .agentEdit()
      .write(
        { command: "read", file: "chapter.md", documentId: DOC_ID },
        { threadId: THREAD_ID, turnId: TURN_ID, responseId: input.responseId },
      ),
  ).resolves.toMatchObject({ isError: false });
  await expect(
    domain.agentEdit().write(
      {
        command: "replace",
        file: "chapter.md",
        documentId: DOC_ID,
        find: "Beta.",
        content: "Beta interim.",
      },
      { threadId: THREAD_ID, turnId: TURN_ID, responseId: input.responseId },
    ),
  ).resolves.toMatchObject({ isError: false });
  await expect(
    domain.agentEdit().write(
      {
        command: "create",
        file: "chapter.md",
        documentId: DOC_ID,
        content: input.finalMarkdown,
        overwrite: true,
      },
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: input.responseId,
        createdDocument: false,
      },
    ),
  ).resolves.toMatchObject({ isError: false });
  await domain.finalizeResponseCommit(input.responseId, {
    threadId: THREAD_ID,
    turnId: TURN_ID,
  });
}

async function appendDraftInsert(
  domain: ReturnType<typeof createFacade>,
  responseId: string,
  turnId: TurnId,
  content: string,
  after?: string,
): Promise<void> {
  await expect(
    domain
      .agentEdit()
      .write(
        { command: "read", file: "chapter.md", documentId: DOC_ID },
        { threadId: THREAD_ID, turnId, responseId },
      ),
  ).resolves.toMatchObject({ isError: false });
  const insert = await domain.agentEdit().write(
    {
      command: "insert",
      file: "chapter.md",
      documentId: DOC_ID,
      content,
      ...(after ? { after } : {}),
    },
    { threadId: THREAD_ID, turnId, responseId },
  );
  if (insert.isError) throw new Error(insert.text);
  await expect(
    domain.finalizeResponseCommit(responseId, { threadId: THREAD_ID, turnId }),
  ).resolves.toMatchObject({
    status: "committed",
  });
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
  const replaced = await domain.agentEdit().write(
    {
      command: "replace",
      file: "chapter.md",
      documentId: DOC_ID,
      find,
      content,
    },
    { threadId: THREAD_ID, turnId: TURN_ID, responseId },
  );
  if (replaced.isError) throw new Error(replaced.text);
  await domain.finalizeResponseCommit(responseId, { threadId: THREAD_ID, turnId: TURN_ID });
  const [draft] = await domain.draftReview.list({ threadId: THREAD_ID });
  if (!draft) throw new Error("expected active draft");
  return { id: draft.id };
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

  liveCoordinator.ensureEmpty(DOC_ID);
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
        scope: "live" as const,
      }));
    },
    async listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId) {
      return (await journal.documentsForTurn(threadId, turnId)).map((documentId) => ({
        documentId: documentId as DocumentId,
        uri: documentId,
        scope: "live" as const,
      }));
    },
  };
}

async function createCommittedDraft(
  db: Parameters<typeof createDrizzleDraftSessionCore>[0]["db"],
  liveCoordinator: ReturnType<typeof createInMemoryCoordinator>,
  draftStore: Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"],
  label: string,
  options: { latestLiveUpdateSeq?: (documentId: DocumentId) => Promise<number> } = {},
) {
  const draftCore = createDrizzleDraftSessionCore({
    db,
    threadId: THREAD_ID,
    liveCoordinator,
    lifecycle: createInMemoryDocumentLifecycle(liveCoordinator),
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

async function seedLiveMarkdown(
  liveCoordinator: ReturnType<typeof createInMemoryCoordinator>,
  liveJournal: Pick<UpdateJournal, "checkpoint">,
  markdown: string,
): Promise<void> {
  const schema = buildDocumentSchema();
  const model = yProsemirrorModel(schema);
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const doc = liveCoordinator.ensureEmpty(DOC_ID);
  model.transact(
    toDocHandle(doc),
    () => model.replaceAllBlocks(toDocHandle(doc), codec.parse(markdown)),
    { type: "user", userId: USER_ID },
  );
  await liveJournal.checkpoint(DOC_ID, Y.encodeStateAsUpdate(doc), 0);
}

async function projectedDraftMarkdown(
  liveJournal: Pick<UpdateJournal, "read">,
  draftStore: Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"],
  draft: { id: string; documentId: DocumentId; baseLiveUpdateSeq: number },
): Promise<string> {
  const schema = buildDocumentSchema();
  const model = yProsemirrorModel(schema);
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const projection = await buildStoredDraftProjection(
    liveJournal,
    draftStore,
    draft.documentId,
    draft.id,
    draft.baseLiveUpdateSeq,
  );
  try {
    return serializePreview(projection, codec, model);
  } finally {
    projection.destroy();
  }
}

async function reviewModel(
  liveJournal: Pick<UpdateJournal, "read">,
  draftStore: Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"],
  liveStore: Pick<ReturnType<typeof createDrizzleCollabPersistence>["store"], "latestUpdateSeq">,
  draftId: string,
) {
  const schema = buildDocumentSchema();
  const model = yProsemirrorModel(schema);
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const snapshot = await buildDraftReviewSnapshot({
    journal: liveJournal,
    draftStore,
    documentId: DOC_ID,
    draftId,
    liveRevisionToken: await liveStore.latestUpdateSeq(DOC_ID),
    draftUpdates: await draftStore.listUpdates(draftId),
    codec,
    model,
  });
  try {
    return {
      live: snapshot.live,
      markdown: snapshot.markdown,
      hunks: snapshot.hunks.map((hunk) => ({
        kind: hunk.kind,
        deletedText: "deletedText" in hunk ? (hunk.deletedText ?? null) : null,
        operationIds: hunk.operationIds,
        spans:
          "spans" in hunk
            ? hunk.spans.map((span) => ({
                operationId: span.operationId,
                anchorFrom: span.anchorFrom,
                anchorTo: span.anchorTo,
              }))
            : [],
      })),
      operations: snapshot.operations.map((operation) => ({
        kind: operation.kind,
        contribution: operation.contribution,
        classification: operation.classification,
        beforeExcerpt: operation.beforeExcerpt,
        afterExcerpt: operation.afterExcerpt,
        sourceUpdateIds: operation.sourceUpdateIds,
        rejectSourceUpdateIds: operation.rejectSourceUpdateIds,
      })),
      wordsAdded: snapshot.wordsAdded,
      wordsRemoved: snapshot.wordsRemoved,
    };
  } finally {
    snapshot.dispose();
  }
}

async function draftUpdateToMarkdown(
  liveJournal: Pick<UpdateJournal, "read">,
  draftStore: Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"],
  liveStore: Pick<ReturnType<typeof createDrizzleCollabPersistence>["store"], "latestUpdateSeq">,
  draftId: string,
  markdown: string,
): Promise<Uint8Array> {
  const schema = buildDocumentSchema();
  const model = yProsemirrorModel(schema);
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const snapshot = await buildDraftReviewSnapshot({
    journal: liveJournal,
    draftStore,
    documentId: DOC_ID,
    draftId,
    liveRevisionToken: await liveStore.latestUpdateSeq(DOC_ID),
    draftUpdates: await draftStore.listUpdates(draftId),
    codec,
    model,
  });
  try {
    const before = Y.encodeStateVector(snapshot.draftDoc);
    model.transact(
      toDocHandle(snapshot.draftDoc),
      () => model.replaceAllBlocks(toDocHandle(snapshot.draftDoc), codec.parse(markdown)),
      { type: "system" },
    );
    return Y.encodeStateAsUpdate(snapshot.draftDoc, before);
  } finally {
    snapshot.dispose();
  }
}

async function readMarkdown(domain: ReturnType<typeof createFacade>, documentId: DocumentId) {
  const read = await domain.readAsMarkdown(documentId);
  if (!read.ok) throw new Error(`read failed: ${read.error.code}`);
  return read.value;
}
