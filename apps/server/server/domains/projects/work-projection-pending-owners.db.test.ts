/** PostgreSQL barrier: an effect toggle publishes the Work projection and agrees with the list and the hint. */
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
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import { createDrizzleWorkDraftPendingStore } from "../collab/adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "../collab/adapters/drizzle-branches.js";
import { createDrizzleDraftStore } from "../collab/adapters/drizzle-drafts.js";
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
        hasEffect: true,
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

    it("publishes an effect toggle on a branch that keeps its reviewable rows", async () => {
      const { db, projection } = await fixture();
      const pending = createDrizzleWorkDraftPendingStore(db);
      await createDrizzleBranchStore(db, {
        workProjection: projection,
        drafts: createDrizzleDraftStore(db),
      }).appendJournal?.({
        branchId: BRANCH_ID,
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
