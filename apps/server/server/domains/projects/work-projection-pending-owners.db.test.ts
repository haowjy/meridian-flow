/** PostgreSQL barriers for real discard, push, and rollback Work projection owners. */
import { catalogScopeKey } from "@meridian/contracts/protocol";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextAvailabilityHeads,
  contextCatalogEntries,
  contextSources,
  documentBranches,
  documents,
  drafts,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import {
  createDrizzleBranchJournalReadStore,
  createDrizzlePushCommitStore,
  createDrizzleWorkDraftPendingStore,
} from "../collab/adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "../collab/adapters/drizzle-branches.js";
import { createDrizzleChangeTrailAggregateWriter } from "../collab/adapters/drizzle-change-trail-aggregate.js";
import { createDrizzleDraftStore } from "../collab/adapters/drizzle-drafts.js";
import {
  createDrizzlePendingSettlementStore,
  stageSettlementBatchWithinTx,
} from "../collab/adapters/drizzle-pending-settlement.js";
import { trailContributionReplacement } from "../collab/domain/branch-trail-projection.js";
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
    const DRAFT_ID = "00000000-0000-4000-8000-00000000094b";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
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
        handle: "w1",
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
        extension: "",
        fileType: "markdown",
      });
      await db.insert(drafts).values({
        id: DRAFT_ID,
        projectId: PROJECT_ID,
        originWorkId: WORK_ID,
        createdBy: USER_ID,
      });
      await db.insert(documentBranches).values({
        id: BRANCH_ID,
        documentId: DOCUMENT_ID,
        kind: "work_draft",
        draftId: DRAFT_ID,
        state: Buffer.from([0, 0]),
        stateVector: Buffer.from([0]),
      });
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      const projection = createWorkProjectionMutation({
        db,
        availability,
        catalog,
        pending: createDrizzleWorkDraftPendingStore(db),
      });
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
          entry?.entry.kind === "authority" ? entry.entry.entityRevision : undefined,
      };
    }

    it("drives real discard, push, and forced rollback owners", async () => {
      const { db, projection } = await fixture();
      const branches = createDrizzleBranchStore(db, {
        workProjection: projection,
        drafts: createDrizzleDraftStore(db),
      });
      const appendJournal = (updateMeta: unknown) =>
        branches.appendJournal?.({
          branchId: BRANCH_ID,
          generation: 1,
          updateData: new Uint8Array([1]),
          source: "agent",
          updateMeta,
        }) ?? Promise.reject(new Error("Drizzle branch journal append is unavailable"));
      const initial = await projectionState();
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
        draftId: DRAFT_ID,
        workId: WORK_ID as never,
        threadId: null,
        generation: 1,
        status: "active" as const,
        state: new Uint8Array([0, 0]),
        stateVector: new Uint8Array([0]),
        schemaVersion: 1 as never,
      };
      const pushStore = createDrizzlePushCommitStore(
        db,
        stageSettlementBatchWithinTx,
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
      // The discard closed those rows and left the branch equal to live; a fresh write makes it
      // differ again before the push stages its row.
      await db
        .update(documentBranches)
        .set({ hasEffect: true })
        .where(eq(documentBranches.id, BRANCH_ID));
      await appendJournal({ kind: "edit" });
      const staged = await projectionState();
      const pushRows = await journal.listReviewableJournalRows(BRANCH_ID, 1);
      const validUpdate = Y.encodeStateAsUpdate(new Y.Doc());
      const trail = {
        documentId: DOCUMENT_ID,
        documentTitle: "chapter.md",
        receiptId: "00000000-0000-4000-8000-000000000946",
        threadIds: [],
        journalOwners: [],
        changes: [],
      };
      await pushStore.commitPushBatch({
        settlement: {
          batchId: "00000000-0000-4000-8000-000000000948",
          claimToken: "00000000-0000-4000-8000-000000000947",
        },
        pushes: [
          {
            branch,
            journalRows: pushRows,
            pushUpdate: validUpdate,
            idempotencyKey: "work-projection-pending-owner-push",
            trail,
            documentTitle: "chapter.md",
            lockCutUpdate: validUpdate,
          },
        ],
      });
      const pushed = await projectionState();
      expect(pushed.entityRevision).toBe((staged.entityRevision ?? 0n) + 1n);
      expect(BigInt(pushed.catalogEntityRevision ?? "0")).toBe(pushed.entityRevision);

      // Withdrawal makes the draft pending again: a refused batch, then a batch whose only
      // member is held, each publish the Work like the push that staged them did.
      let decision: "refuse" | "hold" = "refuse";
      const settlement = createDrizzlePendingSettlementStore(
        db,
        {} as never,
        {} as never,
        createDrizzleChangeTrailAggregateWriter(db),
        {} as never,
        undefined,
        undefined,
        {
          steps: [
            {
              kind: "test_decision",
              async plan() {
                return {
                  async beforeAdmission() {
                    return decision === "refuse"
                      ? { kind: "refuse" as const, reason: { code: "stale" } }
                      : {
                          kind: "proceed" as const,
                          hold: [
                            {
                              itemKey: "chapter",
                              documentId: DOCUMENT_ID as never,
                              reason: { code: "path_taken" },
                            },
                          ],
                        };
                  },
                };
              },
            },
          ],
        },
        projection,
      );
      const settle = async (batchId: string, claimToken: string) => {
        const batch = await settlement.loadSettlementBatch({
          batchId,
          owner: { token: claimToken, epoch: 1 },
        });
        if (!batch) throw new Error("the committer lost its batch");
        return settlement.completeBatch({
          batchId,
          claim: batch.claim,
          members: batch.members.map((member) => ({
            push: member.push,
            joinVersion: member.joinVersion,
            trail: member.trail,
            replacement: trailContributionReplacement(member.trail, member.push),
          })),
          payloads: batch.payloads,
          liveTextFingerprints: new Map(),
          leasedBranchIds: [],
          recheck: () => "commit",
          afterCommit() {},
        });
      };
      const expectPublishedAfter = async (
        previous: Awaited<ReturnType<typeof projectionState>>,
      ) => {
        const state = await projectionState();
        expect(state.entityRevision).toBe((previous.entityRevision ?? 0n) + 1n);
        expect(BigInt(state.catalogEntityRevision ?? "0")).toBe(state.entityRevision);
        expect(state.availabilityGeneration).toBeGreaterThan(previous.availabilityGeneration ?? 0);
        return state;
      };
      await expect(
        settle("00000000-0000-4000-8000-000000000948", "00000000-0000-4000-8000-000000000947"),
      ).resolves.toMatchObject({ status: "refused" });
      const refused = await expectPublishedAfter(pushed);

      decision = "hold";
      await pushStore.commitPushBatch({
        settlement: {
          batchId: "00000000-0000-4000-8000-000000000949",
          claimToken: "00000000-0000-4000-8000-00000000094a",
        },
        pushes: [
          {
            branch,
            journalRows: await journal.listReviewableJournalRows(BRANCH_ID, 1),
            pushUpdate: validUpdate,
            idempotencyKey: "work-projection-pending-owner-push",
            trail,
            documentTitle: "chapter.md",
            lockCutUpdate: validUpdate,
          },
        ],
      });
      const repushed = await expectPublishedAfter(refused);
      await expect(
        settle("00000000-0000-4000-8000-000000000949", "00000000-0000-4000-8000-00000000094a"),
      ).resolves.toMatchObject({ status: "completed", held: [{ itemKey: "chapter" }] });
      await expectPublishedAfter(repushed);
    });

    it("publishes an effect toggle on a branch that keeps its reviewable rows", async () => {
      const { db, projection } = await fixture();
      const pending = createDrizzleWorkDraftPendingStore(db);
      await createDrizzleBranchStore(db, {
        workProjection: projection,
        drafts: createDrizzleDraftStore(db),
      }).appendJournal?.({
        branchId: BRANCH_ID,
        generation: 1,
        updateData: new Uint8Array([1]),
        source: "agent",
        updateMeta: { kind: "edit" },
      });
      const setEffect = (hasEffect: boolean) =>
        projection.mutatePendingBranches([BRANCH_ID], async () => {
          await db
            .update(documentBranches)
            .set({ hasEffect })
            .where(eq(documentBranches.id, BRANCH_ID));
        });
      // The hint and the catalog count read the one membership relation; the Work revision follows.
      const agree = async (members: number) => {
        expect(
          (await pending.countPendingByWorkIds([WORK_ID as never])).get(WORK_ID as never) ?? 0,
        ).toBe(members);
        await expect(
          pending.listDraftsChangingDocument({
            projectId: PROJECT_ID as never,
            documentId: DOCUMENT_ID as never,
          }),
        ).resolves.toHaveLength(members);
      };
      await agree(1);
      for (const [hasEffect, members] of [
        [false, 0],
        [true, 1],
      ] as const) {
        const before = await projectionState();
        await setEffect(hasEffect);
        await agree(members);
        const after = await projectionState();
        expect(after.entityRevision).toBe((before.entityRevision ?? 0n) + 1n);
        expect(BigInt(after.catalogEntityRevision ?? "0")).toBe(after.entityRevision);
        expect(after.availabilityGeneration).toBeGreaterThan(before.availabilityGeneration ?? 0);
      }
    });
  });
}
