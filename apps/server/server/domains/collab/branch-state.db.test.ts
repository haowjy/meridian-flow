/** writeBranchState on real Postgres: a lost CAS writes nothing, cuts round-trip. The effect reaching the Work projection is `projects/work-projection-pending-owners.db.test.ts`'s. */
import { catalogScopeKey } from "@meridian/contracts/protocol";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
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
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import { createDrizzleContextCatalog } from "../context/adapters/context-catalog.js";
import { createDrizzleProjectContextAvailability } from "../context/adapters/project-context-availability.js";
import { createWorkProjectionMutation } from "../projects/adapters/work-projection-mutation.js";
import { createDrizzleWorkDraftPendingStore } from "./adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "./adapters/drizzle-branches.js";
import { createDrizzleDraftStore } from "./adapters/drizzle-drafts.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("writeBranchState (postgres)", () => {});
} else {
  describe("writeBranchState (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000951";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000952";
    const WORK_ID = "00000000-0000-4000-8000-000000000953";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000954";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000955";
    const DRAFT_ID = "00000000-0000-4000-8000-000000000956";
    const BRANCH_ID = "branch_write_branch_state";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });

    async function fixture() {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "write-branch-state"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Write state project",
        slug: "write-state-project",
      });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Write state work",
        slug: "write-state-work",
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
      const branches = createDrizzleBranchStore(db, {
        workProjection: projection,
        drafts: createDrizzleDraftStore(db),
      });
      return { db, branches };
    }

    async function projectionState() {
      const db = database.current;
      const [work] = await db
        .select({ entityRevision: works.entityRevision })
        .from(works)
        .where(eq(works.id, WORK_ID));
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
        catalogEntityRevision:
          entry?.entry.kind === "authority" ? entry.entry.entityRevision : undefined,
      };
    }

    const state = (value: number[]) => ({
      state: new Uint8Array(value),
      stateVector: new Uint8Array([0]),
    });

    // Risk: a lost compare-and-swap that still moves the effect or the base the winner wrote.
    it("writes nothing when the prior state moved", async () => {
      const { db, branches } = await fixture();
      const before = await projectionState();
      await expect(
        runInDrizzleTransaction(db, () =>
          branches.writeBranchState({
            branchId: BRANCH_ID,
            expectedState: new Uint8Array([9, 9]),
            ...state([0, 1]),
            effect: { kind: "text", hasEffect: false },
            baseRevision: { authorityId: "live", authorityGeneration: "1", seq: 7 },
          }),
        ),
      ).resolves.toBe(false);
      const [row] = await db
        .select()
        .from(documentBranches)
        .where(eq(documentBranches.id, BRANCH_ID));
      expect(row?.hasEffect).toBe(true);
      expect(row?.baseRevision).toBeNull();
      expect([...(row?.state ?? [])]).toEqual([0, 0]);
      await expect(projectionState()).resolves.toEqual(before);
    });

    // Risk: bytea[] has no driver mapping of its own; a cut that comes back changed is a replay that diverges.
    it("round-trips rebase cuts as bytes, replaces them on request and leaves them alone otherwise", async () => {
      const { db, branches } = await fixture();
      const cuts = [new Uint8Array([0, 1, 2, 255]), new Uint8Array([]), new Uint8Array([7])];
      const cutsOf = async () => {
        const [row] = await db
          .select({ cuts: documentBranches.rebaseCuts })
          .from(documentBranches)
          .where(eq(documentBranches.id, BRANCH_ID));
        return (row?.cuts ?? []).map((cut) => [...cut]);
      };
      expect(await cutsOf()).toEqual([]);
      const write = (expected: number[], next: number[], rebaseCuts?: Uint8Array[]) =>
        runInDrizzleTransaction(db, () =>
          branches.writeBranchState({
            branchId: BRANCH_ID,
            expectedState: new Uint8Array(expected),
            ...state(next),
            effect: { kind: "text", hasEffect: true },
            ...(rebaseCuts ? { rebaseCuts } : {}),
          }),
        );
      await expect(write([0, 0], [0, 1], cuts)).resolves.toBe(true);
      expect(await cutsOf()).toEqual([[0, 1, 2, 255], [], [7]]);
      await expect(write([0, 1], [0, 2])).resolves.toBe(true);
      expect(await cutsOf()).toEqual([[0, 1, 2, 255], [], [7]]);
      await expect(write([0, 2], [0, 3], [])).resolves.toBe(true);
      expect(await cutsOf()).toEqual([]);
    });
  });
}
