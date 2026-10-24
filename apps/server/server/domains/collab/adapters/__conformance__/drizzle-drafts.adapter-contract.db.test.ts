/**
 * Adapter-contract tests for Drizzle draft peers against local Postgres.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - current drizzle drafts persistence protocol (kb/decisions/collab/drafts/model/shared-branch-per-work.md)
 */

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../../../test-support/work-projection.js";
import { commitDraftRows } from "../../test-support/draft-update-writes.js";
import { createDraftClose } from "../drizzle-draft-close.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle draft store (postgres)", () => {});
} else {
  describe("drizzle draft store adapter contract (postgres)", async () => {
    const dbSchema = await import("@meridian/database/schema");
    const {
      draftWriteJournal,
      contextSources,
      documentDrafts,
      documentYjsCheckpoints,
      documentYjsHeads,
      documents,
      branches,
      projects,
      threadWorks,
      threads,
      turns,
      users,
      works,
    } = dbSchema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../../../../test-support/drizzle-reset.js"
    );
    const { createDrizzleDraftStore } = await import("../drizzle-drafts.js");
    const { readDraftContent } = await import("../../test-support/draft-store-seam.js");
    const { createDrizzleBranchStore } = await import("../drizzle-branches.js");
    const { createHocuspocusPersistenceService } = await import("../../hocuspocus-persistence.js");
    const { createDrizzleWorkBranchPendingStore } = await import(
      "../drizzle-work-branch-pending.js"
    );
    const { createDrizzleCollabPersistence } = await import("../drizzle-journal.js");
    const { createDraftCoordinator } = await import("../../domain/draft-coordinator.js");
    const { COLLAB_SCHEMA_VERSION, packCollabSchemaVersion } = await import(
      "@meridian/prosemirror-schema"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000601";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000602";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000603";
    const WORK_ID = "00000000-0000-4000-8000-000000000604";
    const NEXT_WORK_ID = "00000000-0000-4000-8000-000000000608";
    const BRANCH_ID = "00000000-0000-4000-8000-000000000609";
    const NEXT_BRANCH_ID = "00000000-0000-4000-8000-000000000610";
    const DOC_ID = "00000000-0000-4000-8000-000000000605";
    const THREAD_ID = "00000000-0000-4000-8000-000000000606";
    const TURN_ID = "00000000-0000-4000-8000-000000000607";

    const measuredQueries: string[] = [];
    let captureQueries = false;
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      postgres: {
        debug: (_connection, query) => {
          if (captureQueries) measuredQueries.push(query);
        },
      },
      prepareSuite: async (db) => {
        await deleteDrizzleRows(db, [users]);
        await db.insert(users).values(conformanceUserValues(USER_ID, "drizzle-drafts"));
        await db.insert(projects).values({
          id: PROJECT_ID,
          userId: USER_ID,
          name: "Draft Project",
          slug: "branch-project",
        });
        await db.insert(works).values({
          id: WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Draft Work",
          handle: "w1",
        });
        await db.insert(branches).values({
          id: BRANCH_ID,
          projectId: PROJECT_ID,
          originWorkId: WORK_ID,
          createdBy: USER_ID,
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
          extension: "",
          fileType: "markdown",
        });
        await db.insert(threads).values({
          rootThreadId: THREAD_ID,
          id: THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Thread",
          kind: "primary",
          status: "idle",
        });
        await db.insert(turns).values({
          id: TURN_ID as never,
          threadId: THREAD_ID as never,
          position: 1,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        await db
          .insert(threadWorks)
          .values({ threadId: THREAD_ID, workId: WORK_ID, projectId: PROJECT_ID, isPrimary: true });
      },
    });
    let db = database.current;
    let livePersistence = createDrizzleCollabPersistence(db);
    function createDraftStore() {
      return createDrizzleDraftStore(db, {
        close: createDraftClose(),
        workProjection: createTestWorkProjectionMutation(db),
        live: { journal: livePersistence.journal },
        branches: createDrizzleBranchStore(db),
      });
    }

    let store = createDraftStore();

    function draftRoomPersistence(draftStore = store) {
      return createHocuspocusPersistenceService({
        journal: livePersistence.journal,
        draftStore,
        draftCoordinator: createDraftCoordinator({
          onAppendCommitted: () => {},
          store: draftStore,
        }),
        hocuspocus: () => null,
        metaForOrigin: () => ({ origin: "system", seq: 0 }),
        emitAgentEditInvariantViolation: () => undefined,
      });
    }

    function docWithText(value: string): Y.Doc {
      const doc = new Y.Doc({ gc: false });
      doc.getText("content").insert(0, value);
      return doc;
    }

    function docWithParagraph(clientID: number): Y.Doc {
      const doc = new Y.Doc({ gc: false });
      doc.clientID = clientID;
      doc.getXmlFragment("prosemirror").insert(0, [new Y.XmlElement("paragraph")]);
      return doc;
    }

    beforeEach(async () => {
      db = database.current;
      livePersistence = createDrizzleCollabPersistence(db);
      store = createDraftStore();
    });

    it("returns the winning seed record to both sides of a creation race", async () => {
      const first = docWithParagraph(101);
      const second = docWithParagraph(202);
      const [left, right] = await Promise.all([
        store.ensureDocumentDraft({
          documentId: DOC_ID as never,
          branchId: BRANCH_ID as never,
          liveDoc: first,
          liveRoom: `live:${DOC_ID}:1`,
        }),
        store.ensureDocumentDraft({
          documentId: DOC_ID as never,
          branchId: BRANCH_ID as never,
          liveDoc: second,
          liveRoom: `live:${DOC_ID}:2`,
        }),
      ]);

      expect(right.draftId).toBe(left.draftId);
      expect(right.seed).toEqual(left.seed);
      expect(left.seed?.liveRoom).toMatch(/^live:.*:[12]$/u);
      expect(Object.keys(left.seed?.origins ?? {})).toHaveLength(1);
    });

    it("reseeds a clean thread peer under the reassigned primary Work's draft", async () => {
      const live = docWithText("live prose");
      const { documentDraft: oldPeer } = await store.ensureThreadPeerDraft({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: async () => ({ doc: live, room: null }),
      });
      await db.insert(works).values({
        id: NEXT_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Next Work",
        handle: "w2",
      });
      await db.insert(branches).values({
        id: NEXT_BRANCH_ID,
        projectId: PROJECT_ID,
        originWorkId: NEXT_WORK_ID,
        createdBy: USER_ID,
      });
      await db.transaction(async (tx) => {
        await tx
          .update(threadWorks)
          .set({ isPrimary: false })
          .where(eq(threadWorks.threadId, THREAD_ID));
        await tx.insert(threadWorks).values({
          threadId: THREAD_ID,
          workId: NEXT_WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        });
      });

      await expect(
        store.resolveThreadDraft(DOC_ID as never, THREAD_ID as never),
      ).rejects.toMatchObject({ name: "DraftNotFoundError" });
      const { documentDraft: nextPeer } = await store.ensureThreadPeerDraft({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        branchId: NEXT_BRANCH_ID as never,
        liveDoc: async () => ({ doc: live, room: null }),
      });
      const [oldRow, nextUpstream] = await Promise.all([
        db
          .select({ status: documentDrafts.status, revision: documentDrafts.revision })
          .from(documentDrafts)
          .where(eq(documentDrafts.id, oldPeer.draftId))
          .then((rows) => rows[0]),
        store.getDraft(nextPeer.upstreamDraftId ?? ""),
      ]);

      expect(nextPeer).toMatchObject({
        branchId: NEXT_BRANCH_ID,
        workId: NEXT_WORK_ID,
        threadId: THREAD_ID,
        status: "active",
      });
      expect(nextPeer.draftId).not.toBe(oldPeer.draftId);
      // A close moves the revision, so an exact rewrite computed before it misses.
      expect(oldRow).toMatchObject({ status: "closed", revision: oldPeer.revision + 1 });
      expect(nextUpstream?.workId).toBe(NEXT_WORK_ID);
    });

    it("bulk-appends forty segment rows with one journal insert and no pending scans", async () => {
      const { createWorkProjectionMutation } = await import(
        "../../../projects/adapters/work-projection-mutation.js"
      );
      const { createDrizzleContextCatalog } = await import(
        "../../../context/adapters/context-catalog.js"
      );
      const { createDrizzleProjectContextAvailability } = await import(
        "../../../context/adapters/project-context-availability.js"
      );
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      const projection = createWorkProjectionMutation({
        db,
        pendingCounts: createDrizzleWorkBranchPendingStore(db),
        availability,
        catalog,
      });
      const measuredStore = createDrizzleDraftStore(db, {
        close: createDraftClose(),
        live: { journal: livePersistence.journal },
        workProjection: projection,
        branches: createDrizzleBranchStore(db),
      });
      const base = docWithText("live");
      const documentDraft = await measuredStore.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: base,
        liveRoom: null,
      });
      const snapshot = await measuredStore.getDraft(documentDraft.draftId);
      if (!snapshot) throw new Error("missing batch target");
      const source = new Y.Doc({ gc: false });
      Y.applyUpdate(source, await readDraftContent(measuredStore, documentDraft.draftId));
      const { createDrizzleJournal } = await import("../drizzle-journal.js");
      const wId = await createDrizzleJournal(db).reserveWriteOrdinal(DOC_ID, THREAD_ID);
      const rows = Array.from({ length: 40 }, (_, index) => {
        source.clientID = 10000 + index;
        const before = Y.encodeStateVector(source);
        source.getText("content").insert(source.getText("content").length, String(index));
        return {
          draftId: documentDraft.draftId,
          source: "agent" as const,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          toolCallId: "forty-segment-edit",
          wId,
          updateData: Y.encodeStateAsUpdate(source, before),
        };
      });
      measuredQueries.length = 0;
      captureQueries = true;
      try {
        const coordinator = createDraftCoordinator({
          onAppendCommitted: () => {},
          store: measuredStore,
        });
        expect(
          await commitDraftRows(coordinator, {
            draftId: documentDraft.draftId,
            sourceDoc: source,
            rows,
          }),
        ).toBe(true);
      } finally {
        captureQueries = false;
      }
      // An append locks no Work and counts no pending drafts (#931).
      expect(
        measuredQueries.filter((query) =>
          query.startsWith('(select "branches"."origin_work_id", "document_drafts"."document_id"'),
        ),
      ).toHaveLength(0);
      expect(
        measuredQueries.filter((query) => query.startsWith('insert into "draft_write_journal"')),
      ).toHaveLength(1);
      const persisted = await db
        .select({ toolCallId: draftWriteJournal.toolCallId })
        .from(draftWriteJournal)
        .where(eq(draftWriteJournal.draftId, documentDraft.draftId))
        .orderBy(draftWriteJournal.id);
      expect(persisted.map((row) => row.toolCallId)).toEqual(rows.map((row) => row.toolCallId));
      source.destroy();
      base.destroy();
    });

    it("keeps compacted live documents visible when seeding despite zero live update rows", async () => {
      const live = docWithText("compacted live chapter");
      const [checkpoint] = await db
        .insert(documentYjsCheckpoints)
        .values({
          documentId: DOC_ID as never,
          authorityId: DOC_ID as never,
          authorityGeneration: 1n,
          attributionManifest: { version: 1, floor: null, attributions: [] },
          state: Buffer.from(Y.encodeStateAsUpdate(live)),
          stateVector: Buffer.from(Y.encodeStateVector(live)),
          upToSeq: 1,
          reason: "test-compaction",
        })
        .returning({ id: documentYjsCheckpoints.id });
      await db.insert(documentYjsHeads).values({
        documentId: DOC_ID as never,
        schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
        latestUpdateSeq: 1,
        latestStateVector: Buffer.from(Y.encodeStateVector(live)),
        latestCheckpointId: checkpoint?.id ?? null,
      });
      await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: live,
        liveRoom: null,
      });
    });

    it("G2 §6.1 entry corrupt snapshot fails loudly at draft-room load", async () => {
      const { DraftCorruptError } = await import("../../domain/draft-resolver.js");
      await db.insert(documentDrafts).values({
        id: "draft_corrupt_review_entry",
        documentId: DOC_ID as never,
        kind: "work_draft",
        upstreamDraftId: null,
        branchId: BRANCH_ID as never,
        threadId: null,
        status: "active",
        state: Buffer.from([1, 2]),
        stateVector: Buffer.from([0]),
        schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
      });
      const persistence = draftRoomPersistence();

      await expect(
        persistence.loadHocuspocusDraftState("draft_corrupt_review_entry"),
      ).rejects.toThrow(DraftCorruptError);
    });

    it("never makes a draft in a closed branch: a captured branch's draft stays closed after its close", async () => {
      const { runInDrizzleTransaction } = await import("../../../../shared/drizzle-transaction.js");
      const branchStore = createDrizzleBranchStore(db);
      // Review captured the Work's active branch and its draft, then a whole close ended it.
      const captured = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: docWithText("live"),
        liveRoom: null,
      });
      await runInDrizzleTransaction(db, async () => {
        await branchStore.lockActive(BRANCH_ID as never);
        // The Discard kernel closes the drafts first; the store closes only the row.
        await db
          .update(documentDrafts)
          .set({ closedCause: "discarded", status: "closed" })
          .where(eq(documentDrafts.branchId, BRANCH_ID as never));
        await branchStore.close(BRANCH_ID as never, new Date());
      });
      const before = await db
        .select({ id: documentDrafts.id, status: documentDrafts.status })
        .from(documentDrafts)
        .where(eq(documentDrafts.branchId, BRANCH_ID as never));

      expect
        .soft((await store.getDraft(captured.draftId))?.status, "the captured draft is closed")
        .toBe("closed");
      await expect
        .soft(
          store.ensureDocumentDraft({
            documentId: DOC_ID as never,
            branchId: BRANCH_ID as never,
            liveDoc: docWithText("live"),
            liveRoom: null,
          }),
          "a write boundary refuses the closed branch",
        )
        .rejects.toMatchObject({ name: "DraftStaleUpdateError" });
      expect
        .soft(
          await db
            .select({ id: documentDrafts.id, status: documentDrafts.status })
            .from(documentDrafts)
            .where(eq(documentDrafts.branchId, BRANCH_ID as never)),
          "and no draft row is added",
        )
        .toEqual(before);
    });

    it("G2 §6.1 entry connect failure is a typed draft-room miss, never live fallback", async () => {
      const { parseYjsRoomName } = await import("@meridian/contracts/protocol");
      const persistence = draftRoomPersistence();

      expect(parseYjsRoomName("draft:missing-review-draft")).toEqual({
        kind: "draft",
        draftId: "missing-review-draft",
      });
      expect(parseYjsRoomName("draft:missing-review-draft:gen:1")).toBeNull();
      await expect(
        persistence.resolveDraftHocuspocusRoom("missing-review-draft"),
      ).resolves.toBeNull();
      await expect(
        persistence.loadHocuspocusDraftState("missing-review-draft"),
      ).resolves.toBeUndefined();
    });
    // Risk: an append is sequenced by the row lock, not fenced by the revision (design §2):
    // it lands at any revision, refuses only a closed, re-forked or frozen draft, and an
    // outcome that writes nothing must roll its bump back even inside a caller's transaction.
    it("an append lands at any revision, refuses a closed draft, and rolls back what it does not write", async () => {
      const documentDraft = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: docWithText("seed"),
        liveRoom: null,
      });
      const row = (updateData: Uint8Array) => ({
        draftId: documentDraft.draftId,
        updateData,
        source: "agent" as const,
      });
      const append = (
        status: "contained" | "prefixMissing" | null,
        updateData = Y.encodeStateAsUpdate(docWithText("changed")),
      ) =>
        store.appendRows({
          draftId: documentDraft.draftId,
          documentId: DOC_ID as never,
          base: { checkpointRevision: 0, seq: 0 },
          finalize: () =>
            status === "contained"
              ? { status }
              : status === "prefixMissing"
                ? { status, clocks: [] }
                : { status: "appended", rows: [row(updateData)], receipts: [] },
        });
      // Another write moved the revision: the append still lands, at the next one.
      await db
        .update(documentDrafts)
        .set({ revision: documentDraft.revision + 5 })
        .where(eq(documentDrafts.id, documentDraft.draftId));
      await expect(append(null)).resolves.toMatchObject({
        status: "appended",
        revision: documentDraft.revision + 6,
      });
      const revision = documentDraft.revision + 6;
      const { runInDrizzleTransaction } = await import("../../../../shared/drizzle-transaction.js");
      // Inside an ambient transaction that commits: the outcome's savepoint unwinds the bump.
      for (const status of ["contained", "prefixMissing"] as const) {
        await runInDrizzleTransaction(db, async () => {
          await expect(append(status)).resolves.toMatchObject({ status });
        });
        expect((await store.getDraft(documentDraft.draftId))?.revision).toBe(revision);
      }
      await db
        .update(documentDrafts)
        .set({ status: "closed", closedCause: "discarded" })
        .where(eq(documentDrafts.id, documentDraft.draftId));
      await expect(append(null)).resolves.toEqual({ status: "refused" });
      const journalRows = await db
        .select({ id: draftWriteJournal.id })
        .from(draftWriteJournal)
        .where(eq(draftWriteJournal.draftId, documentDraft.draftId));
      expect(journalRows).toHaveLength(1);
    });
  });
}
