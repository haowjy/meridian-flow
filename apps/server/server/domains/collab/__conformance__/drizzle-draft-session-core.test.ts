/** Integration proof for draft-scoped agent-edit response commits. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
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

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000501" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-000000000502";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000503";
const DOC_ID = "00000000-0000-4000-8000-000000000504" as DocumentId;
const THREAD_ID = "00000000-0000-4000-8000-000000000505" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000506" as TurnId;

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
      documentYjsDraftUpdates,
      documentYjsReversals,
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
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleDraftStore } = await import("../adapters/drizzle-drafts.js");

    const db = createDb(DATABASE_URL, { max: 4 });
    const draftStore = createDrizzleDraftStore(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        documentYjsDraftUpdates,
        documentYjsDrafts,
        agentEditSyncState,
        agentEditMutations,
        agentEditWidCounters,
        documentYjsReversals,
        turns,
        threads,
        documents,
        folders,
        contextSources,
        projects,
        users,
      ]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "draft-session-core"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Draft Core Project",
        slug: "draft-core-project",
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Draft Core Source",
        slug: "draft-core-source",
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
        title: "Draft Core Thread",
        kind: "primary",
        status: "active",
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
        domain.drafts.acceptDraft({ documentId: DOC_ID, threadId: THREAD_ID, userId: USER_ID }),
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

      await domain.drafts.acceptDraft({ documentId: DOC_ID, threadId: THREAD_ID, userId: USER_ID });
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
        domain.drafts.acceptDraft({ documentId: DOC_ID, threadId: THREAD_ID, userId: USER_ID }),
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

    it("lets only one concurrent draft finalizer mutate live state", async () => {
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
        { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-concurrent" },
      );
      await draftCore.commitResponse("response-concurrent");
      const draft = await draftStore.getActiveDraft({ documentId: DOC_ID, threadId: THREAD_ID });
      if (!draft) throw new Error("expected active draft");

      const [accept, reject] = await Promise.all([
        domain.drafts.acceptDraft({ documentId: DOC_ID, threadId: THREAD_ID, userId: USER_ID }),
        domain.drafts.rejectDraft({ documentId: DOC_ID, threadId: THREAD_ID }),
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

    it("fences a stale accept after reject reclaims an expired claim", async () => {
      const { domain, liveCoordinator, liveJournal } = createLiveHarness(db, draftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await createCommittedDraft(db, liveCoordinator, draftStore, "reclaim-reject");

      const staleClaim = await draftStore.claimActive({ documentId: DOC_ID, threadId: THREAD_ID });
      expect(staleClaim).toMatchObject({ id: draft.id, status: "active" });
      if (!staleClaim?.claimToken) throw new Error("expected stale claim token");
      await expireClaim(db, documentYjsDrafts, draft.id);

      await expect(
        domain.drafts.rejectDraft({ documentId: DOC_ID, threadId: THREAD_ID }),
      ).resolves.toEqual({
        status: "discarded",
        draftId: draft.id,
      });

      const staleApplied = await staleAcceptResume({
        draft: staleClaim,
        draftStore,
        liveJournal,
        liveCoordinator,
      });

      expect(staleApplied).toBe(false);
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "discarded" });
      expect(await readMarkdown(domain, DOC_ID)).not.toContain("Draft reclaim-reject.");
    });

    it("fences a stale double-accept after another accept reclaims an expired claim", async () => {
      const { domain, liveCoordinator, liveJournal } = createLiveHarness(db, draftStore);
      await domain.writeDocument({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        markdown: "Alpha live.",
        origin: { type: "user", actorUserId: USER_ID },
      });
      const draft = await createCommittedDraft(db, liveCoordinator, draftStore, "reclaim-accept");

      const staleClaim = await draftStore.claimActive({ documentId: DOC_ID, threadId: THREAD_ID });
      expect(staleClaim).toMatchObject({ id: draft.id, status: "active" });
      if (!staleClaim?.claimToken) throw new Error("expected stale claim token");
      await expireClaim(db, documentYjsDrafts, draft.id);

      await expect(
        domain.drafts.acceptDraft({ documentId: DOC_ID, threadId: THREAD_ID, userId: USER_ID }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });

      const staleApplied = await staleAcceptResume({
        draft: staleClaim,
        draftStore,
        liveJournal,
        liveCoordinator,
      });

      expect(staleApplied).toBe(false);
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "applied" });
      const after = await readMarkdown(domain, DOC_ID);
      expect(after).toContain("Draft reclaim-accept.");
      expect(after.match(/Draft reclaim-accept\./g)).toHaveLength(1);
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
      await domain.drafts.acceptDraft({ documentId: DOC_ID, threadId: THREAD_ID, userId: USER_ID });
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

    it("retries draft scoped cleanup after an applied retry", async () => {
      let cleanupCalls = 0;
      const flakyDraftStore = {
        ...draftStore,
        async deleteScopedState(input: Parameters<typeof draftStore.deleteScopedState>[0]) {
          cleanupCalls += 1;
          if (cleanupCalls === 1) throw new Error("cleanup failed once");
          await draftStore.deleteScopedState(input);
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
        domain.drafts.acceptDraft({ documentId: DOC_ID, threadId: THREAD_ID, userId: USER_ID }),
      ).rejects.toThrow("cleanup failed once");
      await expect(draftStore.getDraft(draft.id)).resolves.toMatchObject({ status: "applied" });
      await expect(
        domain.drafts.acceptDraft({ documentId: DOC_ID, threadId: THREAD_ID, userId: USER_ID }),
      ).resolves.toMatchObject({ status: "applied", draftId: draft.id });
      expect(cleanupCalls).toBe(2);
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

      await domain.drafts.acceptDraft({ documentId: DOC_ID, threadId: THREAD_ID, userId: USER_ID });
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
      draftAcceptJournal: createInMemoryDraftAcceptJournal(liveJournal),
      threads: {
        async findById(id) {
          return id === THREAD_ID ? { userId: USER_ID, projectId: PROJECT_ID } : null;
        },
      },
      projectPreferences: {
        async read() {
          await options.beforePreferenceRead?.();
          return { aiWriteMode: options.aiWriteMode ?? "direct" };
        },
      },
      createDraftSessionCore: ({ threadId }) =>
        createDrizzleDraftSessionCore({
          db,
          threadId,
          liveCoordinator,
          draftStore,
        }),
      documentWriteHook: options.documentWriteHook,
    }),
    liveCoordinator,
    liveJournal,
  };
}

function storeFor(journal: ReturnType<typeof createInMemoryJournal>): CollabFacadeStore {
  return {
    createCheckpoint: (docId, state, reason, upToSeq) =>
      journal.createCheckpoint(docId, state, reason, upToSeq),
    getCheckpoint: (id) => journal.getCheckpoint(id),
    listCheckpoints: (docId) => journal.listCheckpoints(docId),
    latestUpdate: (docId) => journal.latestUpdate(docId),
  };
}

async function createCommittedDraft(
  db: Parameters<typeof createDrizzleDraftSessionCore>[0]["db"],
  liveCoordinator: ReturnType<typeof createInMemoryCoordinator>,
  draftStore: Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"],
  label: string,
) {
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

async function staleAcceptResume(input: {
  draft: NonNullable<
    Awaited<
      ReturnType<Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"]["claimActive"]>
    >
  >;
  draftStore: Parameters<typeof createDrizzleDraftSessionCore>[0]["draftStore"];
  liveJournal: ReturnType<typeof createInMemoryJournal>;
  liveCoordinator: ReturnType<typeof createInMemoryCoordinator>;
}) {
  const updates = await input.draftStore.listUpdates(input.draft.id);
  if (!input.draft.claimToken) throw new Error("expected claim token");
  if (!input.draft.lastActorTurnId) throw new Error("expected last actor turn");
  const mergedUpdate = Y.mergeUpdates(updates.map((update) => update.updateData));
  const acceptJournal = createInMemoryDraftAcceptJournal(input.liveJournal);
  const writeId = `draft-accept:${input.draft.id}`;
  let appliedUpdateSeq = await acceptJournal.findUpdateSeqByWriteId({
    documentId: DOC_ID,
    threadId: THREAD_ID,
    writeId,
  });
  if (appliedUpdateSeq === null) {
    const [result] = await acceptJournal.appendBatch([
      {
        docId: DOC_ID,
        update: mergedUpdate,
        meta: { origin: "system", actorTurnId: input.draft.lastActorTurnId, seq: 0 },
        mutation: { threadId: THREAD_ID, turnId: input.draft.lastActorTurnId, writeId },
      },
    ]);
    if (!result) throw new Error("expected accepted draft journal append");
    appliedUpdateSeq = result.seq;
  }
  const applied = await input.draftStore.markApplied(input.draft.id, {
    claimToken: input.draft.claimToken,
    appliedByUserId: USER_ID,
    appliedUpdateSeq,
  });
  if (applied) {
    await input.liveCoordinator.withDocument(DOC_ID, async (doc) => {
      Y.applyUpdate(doc, mergedUpdate, { type: "system" });
    });
  }
  return applied;
}

async function readMarkdown(domain: ReturnType<typeof createFacade>, documentId: DocumentId) {
  const read = await domain.readAsMarkdown(documentId);
  if (!read.ok) throw new Error(`read failed: ${read.error.code}`);
  return read.value;
}
