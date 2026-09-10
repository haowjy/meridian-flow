/** PostgreSQL barriers for real discard, redo, push, and rollback Work projection owners. */
import { catalogScopeKey } from "@meridian/contracts/protocol";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextAvailabilityHeads,
  contextCatalogEntries,
  contextSources,
  documentBranches,
  documents,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { truncateDrizzleTables } from "../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../test-support/rollback-test-database.js";
import {
  createDrizzleBranchJournalReadStore,
  createDrizzlePushCommitStore,
} from "../collab/adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "../collab/adapters/drizzle-branches.js";
import { createDrizzleChangeTrailAggregateWriter } from "../collab/adapters/drizzle-change-trail-aggregate.js";
import { stagePendingSettlementWithinTx } from "../collab/adapters/drizzle-pending-settlement.js";
import { createBranchCriticalSections } from "../collab/domain/branch-critical-sections.js";
import { createDrizzleContextCatalog } from "../context/adapters/context-catalog.js";
import { createDrizzleProjectContextAvailability } from "../context/adapters/project-context-availability.js";
import { createWorkProjectionMutation } from "./adapters/work-projection-mutation.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work projection pending production owners (postgres)", () => {});
} else {
  describe("Work projection pending production owners (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000941";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000942";
    const WORK_ID = "00000000-0000-4000-8000-000000000943";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000944";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000945";
    const BRANCH_ID = "branch_work_projection_pending_owner";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });

    async function fixture() {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "work-pending-owner"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Pending owner project",
        slug: "pending-owner-project",
      });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Pending owner work",
        slug: "pending-owner-work",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        workId: WORK_ID,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
      });
      await db.insert(documents).values({
        id: DOCUMENT_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(documentBranches).values({
        id: BRANCH_ID,
        documentId: DOCUMENT_ID,
        kind: "work_draft",
        workId: WORK_ID,
        state: Buffer.from([0]),
        stateVector: Buffer.from([0]),
      });
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      const projection = createWorkProjectionMutation({ db, availability, catalog });
      await catalog.refreshProject(PROJECT_ID);
      return { db, projection };
    }

    async function projectionState() {
      const db = database.current;
      const [work] = await db
        .select({ entityRevision: works.entityRevision })
        .from(works)
        .where(eq(works.id, WORK_ID));
      const [head] = await db
        .select({ generation: contextAvailabilityHeads.generation })
        .from(contextAvailabilityHeads)
        .where(eq(contextAvailabilityHeads.authorityKey, `project:${PROJECT_ID}`));
      const [entry] = await db
        .select({ entry: contextCatalogEntries.entry })
        .from(contextCatalogEntries)
        .where(
          and(
            eq(
              contextCatalogEntries.scopeKey,
              catalogScopeKey({ kind: "project", projectId: PROJECT_ID }),
            ),
            eq(contextCatalogEntries.entryId, WORK_ID),
          ),
        );
      return {
        entityRevision: work?.entityRevision,
        availabilityGeneration: head?.generation,
        catalogEntityRevision:
          entry?.entry.kind === "authority" && entry.entry.authority.kind === "work"
            ? entry.entry.entityRevision
            : undefined,
      };
    }

    it("drives real discard, redo, push, and forced rollback owners", async () => {
      const { db, projection } = await fixture();
      const branches = createDrizzleBranchStore(
        db,
        undefined,
        createBranchCriticalSections(),
        projection,
      );
      const appendJournal = (updateMeta: unknown) =>
        branches.appendJournal?.({
          branchId: BRANCH_ID,
          generation: 1,
          updateData: new Uint8Array([1]),
          source: "agent",
          updateMeta,
        }) ?? Promise.reject(new Error("Drizzle branch journal append is unavailable"));
      const initial = await projectionState();
      await appendJournal({ kind: "manifest_membership", documentId: DOCUMENT_ID });
      await expect(projectionState()).resolves.toEqual(initial);
      await appendJournal({ kind: "edit" });
      const appended = await projectionState();
      expect(appended.entityRevision).toBe((initial.entityRevision ?? 0n) + 1n);
      await appendJournal({ kind: "edit" });
      await expect(projectionState()).resolves.toEqual(appended);

      const journal = createDrizzleBranchJournalReadStore(db);
      const rows = await journal.listReviewableJournalRows(BRANCH_ID, 1);
      const branch = {
        branchId: BRANCH_ID,
        documentId: DOCUMENT_ID as never,
        kind: "work_draft" as const,
        upstreamBranchId: null,
        workId: WORK_ID as never,
        threadId: null,
        pushPolicy: "manual" as const,
        generation: 1,
        status: "active" as const,
        state: new Uint8Array([0]),
        stateVector: new Uint8Array([0]),
        schemaVersion: 1 as never,
      };
      const pushStore = createDrizzlePushCommitStore(
        db,
        stagePendingSettlementWithinTx,
        createDrizzleChangeTrailAggregateWriter(db),
        undefined,
        projection,
      );
      await expect(
        runInDrizzleTransaction(db, async () => {
          await pushStore.commitDiscard({
            branch,
            journalRows: rows,
            state: branch.state,
            stateVector: branch.stateVector,
          });
          throw new Error("forced owner rollback");
        }),
      ).rejects.toThrow("forced owner rollback");
      await expect(projectionState()).resolves.toEqual(appended);
      expect(
        (await journal.listReviewableJournalRows(BRANCH_ID, 1)).map(({ status }) => status),
      ).toEqual(rows.map(({ status }) => status));

      await pushStore.commitDiscard({
        branch,
        journalRows: rows,
        state: branch.state,
        stateVector: branch.stateVector,
      });
      const discarded = await projectionState();
      expect(discarded.entityRevision).toBe((appended.entityRevision ?? 0n) + 1n);
      await pushStore.commitTurnRedo({
        branch,
        journalRows: rows,
        state: branch.state,
        stateVector: branch.stateVector,
      });
      const redone = await projectionState();
      expect(redone.entityRevision).toBe((discarded.entityRevision ?? 0n) + 1n);

      const validUpdate = Y.encodeStateAsUpdate(new Y.Doc());
      const trail = {
        documentId: DOCUMENT_ID,
        documentTitle: "chapter.md",
        receiptId: "00000000-0000-4000-8000-000000000946",
        threadIds: [],
        journalOwners: [],
        changes: [],
      };
      await pushStore.commitPush({
        branch,
        journalRows: rows,
        pushUpdate: validUpdate,
        idempotencyKey: "work-projection-pending-owner-push",
        trail,
        pendingLiveSettlement: {
          documentTitle: "chapter.md",
          lockCutUpdate: validUpdate,
          pushUpdate: validUpdate,
          postCutUpdates: [],
          trail,
          sweepEvidence: null,
          joinVersion: 0,
          settledJoinVersion: null,
          claim: {
            token: "00000000-0000-4000-8000-000000000947",
            epoch: 1,
            kind: "warm",
            leaseExpiresAt: new Date(Date.now() + 30_000),
          },
          attemptCount: 0,
          state: "pending",
        },
      });
      const pushed = await projectionState();
      expect(pushed.entityRevision).toBe((redone.entityRevision ?? 0n) + 1n);
      expect(BigInt(pushed.catalogEntityRevision ?? "0")).toBe(pushed.entityRevision);
    });
  });
}
