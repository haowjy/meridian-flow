/** Adapter-contract tests for the Drizzle DraftStore against local Postgres. */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ActiveDraftConflictError } from "../../domain/drafts.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000401";
const PROJECT_ID = "00000000-0000-4000-8000-000000000402";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000403";
const WORK_ID = "00000000-0000-4000-8000-000000000409";
const DOC_ID = "00000000-0000-4000-8000-000000000404";
const DOC_B_ID = "00000000-0000-4000-8000-000000000408";
const THREAD_ID = "00000000-0000-4000-8000-000000000405";
const PEER_THREAD_ID = "00000000-0000-4000-8000-000000000410";
const TURN_A = "00000000-0000-4000-8000-000000000406";
const TURN_B = "00000000-0000-4000-8000-000000000407";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle draft store (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle draft store adapter contract (postgres)", async () => {
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
      threadWorks,
      threads,
      turns,
      works,
      users,
    } = dbSchema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleDraftStore } = await import("../drizzle-drafts.js");

    const db = createDb(DATABASE_URL, { max: 4 });
    const store = createDrizzleDraftStore(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        documentYjsDraftUpdates,
        documentYjsDrafts,
        agentEditSyncState,
        agentEditMutations,
        agentEditWidCounters,
        documentYjsReversals,
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
      await db.insert(users).values(conformanceUserValues(USER_ID, "drizzle-drafts"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Draft Project",
        slug: "draft-project",
      });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Draft Work",
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Draft Source",
        slug: "draft-source",
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
      await db.insert(threads).values([
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Draft Thread",
          kind: "primary",
          status: "active",
        },
        {
          id: PEER_THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Peer Draft Thread",
          kind: "primary",
          status: "active",
        },
      ]);
      await db.insert(threadWorks).values([
        {
          threadId: THREAD_ID,
          workId: WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        },
        {
          threadId: PEER_THREAD_ID,
          workId: WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        },
      ]);
      await db.insert(turns).values([
        { id: TURN_A, threadId: THREAD_ID, role: "assistant", status: "complete" },
        {
          id: TURN_B,
          threadId: THREAD_ID,
          parentTurnId: TURN_A,
          role: "assistant",
          status: "complete",
        },
      ]);
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("persists draft updates and maps partial-unique active conflicts", async () => {
      const draft = await store.createActiveDraft({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        lastActorTurnId: TURN_A as never,
      });

      await expect(
        store.createActiveDraft({ documentId: DOC_ID as never, threadId: THREAD_ID as never }),
      ).rejects.toBeInstanceOf(ActiveDraftConflictError);

      await store.appendUpdate({
        draftId: draft.id,
        updateData: appendText("Alpha"),
        actorTurnId: TURN_B as never,
      });
      await store.appendUpdate({
        draftId: draft.id,
        updateData: appendText("writer"),
        actorUserId: USER_ID as never,
      });

      expect(
        await store.getActiveDraft({ documentId: DOC_ID as never, threadId: THREAD_ID as never }),
      ).toMatchObject({
        id: draft.id,
        status: "active",
        lastActorTurnId: TURN_B,
      });
      expect(await store.listUpdates(draft.id)).toMatchObject([
        { draftId: draft.id, actorTurnId: TURN_B, actorUserId: null },
        { draftId: draft.id, actorTurnId: null, actorUserId: USER_ID },
      ]);
    });

    it("rejects finalized draft appends without inserting an update row", async () => {
      const draft = await store.createActiveDraft({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        lastActorTurnId: TURN_A as never,
      });
      await store.reject({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        draftId: draft.id,
      });

      await expect(
        store.appendUpdate({
          draftId: draft.id,
          updateData: appendText("too late"),
          actorTurnId: TURN_B as never,
        }),
      ).rejects.toThrow(`Draft is closed: ${draft.id}`);
      expect(await store.listUpdates(draft.id)).toEqual([]);
    });

    it("shares one active draft across threads in the same work", async () => {
      const draft = await store.createActiveDraft({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        lastActorTurnId: TURN_A as never,
      });

      await expect(
        store.getActiveDraft({ documentId: DOC_ID as never, threadId: PEER_THREAD_ID as never }),
      ).resolves.toMatchObject({ id: draft.id, workId: WORK_ID });
      await expect(
        store.createActiveDraft({ documentId: DOC_ID as never, threadId: PEER_THREAD_ID as never }),
      ).rejects.toBeInstanceOf(ActiveDraftConflictError);
      await expect(
        store.listActiveDrafts({ threadId: PEER_THREAD_ID as never }),
      ).resolves.toMatchObject([{ id: draft.id, workId: WORK_ID }]);
    });

    it("lists only active drafts for a thread", async () => {
      const first = await store.createActiveDraft({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        lastActorTurnId: TURN_A as never,
      });
      const second = await store.createActiveDraft({
        documentId: DOC_B_ID as never,
        threadId: THREAD_ID as never,
        lastActorTurnId: TURN_B as never,
      });
      const claimed = await store.beginAccept({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        draftId: first.id,
      });
      if (claimed.status !== "claimed") throw new Error("expected accept claim");
      await store.reject({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        draftId: first.id,
        acceptLease: claimed.lease,
      });

      await expect(store.listActiveDrafts({ threadId: THREAD_ID as never })).resolves.toMatchObject(
        [
          {
            id: second.id,
            documentId: DOC_B_ID,
            documentName: "chapter-b",
            workId: WORK_ID,
            status: "active",
            lastActorTurnId: TURN_B,
          },
        ],
      );

      await expect(
        store.listReviewableDrafts({ threadId: THREAD_ID as never }),
      ).resolves.toMatchObject([
        {
          id: first.id,
          documentId: DOC_ID,
          documentName: "chapter",
          workId: WORK_ID,
          status: "discarded",
          lastActorTurnId: TURN_A,
        },
        {
          id: second.id,
          documentId: DOC_B_ID,
          documentName: "chapter-b",
          workId: WORK_ID,
          status: "active",
          lastActorTurnId: TURN_B,
        },
      ]);
    });

    it("issues a fresh accept fencing token on reclaim and fences stale terminal writes", async () => {
      const draft = await store.createActiveDraft({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        lastActorTurnId: TURN_A as never,
      });

      const firstClaim = await store.beginAccept({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        draftId: draft.id,
      });
      expect(firstClaim).toMatchObject({
        status: "claimed",
        draft: { id: draft.id, status: "accepting" },
      });
      if (firstClaim.status !== "claimed") throw new Error("expected first claim");
      await db
        .update(documentYjsDrafts)
        .set({ claimedAt: sql`now() - interval '11 minutes'` })
        .where(eq(documentYjsDrafts.id, draft.id));

      const secondClaim = await store.beginAccept({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        draftId: draft.id,
      });
      expect(secondClaim).toMatchObject({
        status: "claimed",
        draft: { id: draft.id, status: "accepting" },
      });
      if (secondClaim.status !== "claimed") throw new Error("expected second claim");
      expect(secondClaim.lease.id).not.toBe(firstClaim.lease.id);

      await expect(
        store.reject({
          documentId: DOC_ID as never,
          threadId: THREAD_ID as never,
          draftId: draft.id,
          acceptLease: firstClaim.lease,
        }),
      ).resolves.toBeNull();
      await expect(
        store.reject({
          documentId: DOC_ID as never,
          threadId: THREAD_ID as never,
          draftId: draft.id,
          acceptLease: secondClaim.lease,
        }),
      ).resolves.toMatchObject({ status: "discarded" });
      await expect(store.getDraft(draft.id)).resolves.toMatchObject({ status: "discarded" });
    });
  });
}

function appendText(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.insert(0, value);
  return Y.encodeStateAsUpdate(doc, before);
}
