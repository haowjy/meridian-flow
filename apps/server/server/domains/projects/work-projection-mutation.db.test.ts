/** PostgreSQL barriers for the production Work projection publication owner. */
import { catalogScopeKey } from "@meridian/contracts/protocol";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextAvailabilityHeads,
  contextCatalogCommits,
  contextCatalogEntries,
  contextCatalogScopeHeads,
  contextSources,
  documentBranches,
  documents,
  projects,
  threads,
  threadWorks,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { truncateDrizzleTables } from "../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../test-support/rollback-test-database.js";
import {
  createDrizzleBranchJournalReadStore,
  createDrizzlePushCommitStore,
} from "../collab/adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "../collab/adapters/drizzle-branches.js";
import { createDrizzleChangeTrailAggregateWriter } from "../collab/adapters/drizzle-change-trail-aggregate.js";
import { createDrizzleDocumentProjectionEffects } from "../collab/adapters/drizzle-document-activity.js";
import { stagePendingSettlementWithinTx } from "../collab/adapters/drizzle-pending-settlement.js";
import { createBranchCriticalSections } from "../collab/domain/branch-critical-sections.js";
import { createDrizzleContextCatalog } from "../context/adapters/context-catalog.js";
import { createDrizzleProjectContextAvailability } from "../context/adapters/project-context-availability.js";
import { createDrizzleRepositories } from "../threads/adapters/drizzle/index.js";
import { createWorkProjectionMutation } from "./adapters/work-projection-mutation.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work projection publication owner (postgres)", () => {});
} else {
  describe("Work projection publication owner (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000901";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000902";
    const WORK_ID = "00000000-0000-4000-8000-000000000903";
    const THREAD_ID = "00000000-0000-4000-8000-000000000904";
    const TURN_ID = "00000000-0000-4000-8000-000000000905";
    const SECOND_WORK_ID = "00000000-0000-4000-8000-000000000906";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000907";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000908";
    const SECOND_SOURCE_ID = "00000000-0000-4000-8000-000000000912";
    const SECOND_DOCUMENT_ID = "00000000-0000-4000-8000-000000000913";
    const BRANCH_ID = "branch_work_projection_owner";
    const SECOND_BRANCH_ID = "branch_work_projection_owner_second";
    const OTHER_PROJECT_ID = "00000000-0000-4000-8000-000000000914";
    const OTHER_WORK_ID = "00000000-0000-4000-8000-000000000915";
    const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000916";
    const OTHER_DOCUMENT_ID = "00000000-0000-4000-8000-000000000917";
    const OTHER_BRANCH_ID = "branch_work_projection_owner_other_project";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });
    async function fixture() {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "work-projection"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Projection project",
        slug: "projection-project",
      });
      await db.insert(projects).values({
        id: OTHER_PROJECT_ID,
        userId: USER_ID,
        name: "Other projection project",
        slug: "other-projection-project",
      });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Projection work",
        slug: "projection-work",
      });
      await db.insert(works).values({
        id: SECOND_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Unaffected work",
        slug: "unaffected-work",
      });
      await db.insert(works).values({
        id: OTHER_WORK_ID,
        projectId: OTHER_PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Other project work",
        slug: "other-project-work",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        workId: WORK_ID,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
      });
      await db.insert(contextSources).values({
        id: SECOND_SOURCE_ID,
        workId: SECOND_WORK_ID,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
      });
      await db.insert(contextSources).values({
        id: OTHER_SOURCE_ID,
        workId: OTHER_WORK_ID,
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
      await db.insert(documents).values({
        id: SECOND_DOCUMENT_ID,
        contextSourceId: SECOND_SOURCE_ID,
        name: "chapter-two",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(documents).values({
        id: OTHER_DOCUMENT_ID,
        contextSourceId: OTHER_SOURCE_ID,
        name: "other-chapter",
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
      await db.insert(documentBranches).values({
        id: SECOND_BRANCH_ID,
        documentId: SECOND_DOCUMENT_ID,
        kind: "work_draft",
        workId: SECOND_WORK_ID,
        state: Buffer.from([0]),
        stateVector: Buffer.from([0]),
      });
      await db.insert(documentBranches).values({
        id: OTHER_BRANCH_ID,
        documentId: OTHER_DOCUMENT_ID,
        kind: "work_draft",
        workId: OTHER_WORK_ID,
        state: Buffer.from([0]),
        stateVector: Buffer.from([0]),
      });
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Projection thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(threadWorks).values({
        threadId: THREAD_ID,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      const projection = createWorkProjectionMutation({ db, availability, catalog });
      await catalog.refreshProject(PROJECT_ID);
      await catalog.refreshProject(OTHER_PROJECT_ID);
      return { db, projection, catalog };
    }
    async function projectionState() {
      const db = database.current;
      const [work] = await db
        .select({ entityRevision: works.entityRevision, updatedAt: works.updatedAt })
        .from(works)
        .where(eq(works.id, WORK_ID));
      const [head] = await db
        .select({ generation: contextAvailabilityHeads.generation })
        .from(contextAvailabilityHeads)
        .where(eq(contextAvailabilityHeads.authorityKey, `project:${PROJECT_ID}`));
      const catalog = createDrizzleContextCatalog(db);
      const snapshot = await catalog.snapshot({ kind: "project", projectId: PROJECT_ID });
      const authority = snapshot.entries.find((entry) => entry.entryId === WORK_ID);
      return {
        entityRevision: work?.entityRevision,
        updatedAt: work?.updatedAt,
        availabilityGeneration: head?.generation,
        catalogEntityRevision:
          authority?.kind === "authority" && authority.authority.kind === "work"
            ? authority.entityRevision
            : undefined,
      };
    }
    it("commits turn activity, entity authority, catalog signal, and project head together", async () => {
      const { projection } = await fixture();
      const before = await projectionState();
      await createDrizzleRepositories(database.current, projection).turns.create({
        id: TURN_ID,
        threadId: THREAD_ID,
        role: "user",
      });
      const after = await projectionState();
      expect(after.updatedAt?.getTime()).toBeGreaterThan(before.updatedAt?.getTime() ?? 0);
      expect(after.entityRevision).toBe((before.entityRevision ?? 0n) + 1n);
      expect(BigInt(after.catalogEntityRevision ?? "0")).toBe(after.entityRevision);
      expect(after.availabilityGeneration).toBeGreaterThan(before.availabilityGeneration ?? 0n);
    });
    it("rolls turn activity and every authority signal back with its outer transaction", async () => {
      const { projection } = await fixture();
      const repos = createDrizzleRepositories(database.current, projection);
      const before = await projectionState();
      await expect(
        repos.transaction(async () => {
          await repos.turns.create({ id: TURN_ID, threadId: THREAD_ID, role: "user" });
          throw new Error("forced rollback");
        }),
      ).rejects.toThrow("forced rollback");
      await expect(projectionState()).resolves.toEqual(before);
      await expect(repos.turns.findById(TURN_ID)).resolves.toBeNull();
    });
    it("publishes document activity through the same atomic owner", async () => {
      const { projection } = await fixture();
      const effects = createDrizzleDocumentProjectionEffects(database.current, projection);
      const before = await projectionState();
      const at = new Date("2026-08-29T12:34:56.789Z");
      await effects.touchDocumentActivity({ documentId: DOCUMENT_ID, at });
      const after = await projectionState();
      expect(after.updatedAt).toEqual(at);
      expect(after.entityRevision).toBe((before.entityRevision ?? 0n) + 1n);
      expect(after.catalogEntityRevision).toBe(String(after.entityRevision));
      expect(after.availabilityGeneration).toBeGreaterThan(before.availabilityGeneration ?? 0n);
    });
    it("aggregates distinct Works into one project commit, head, wake, and availability generation", async () => {
      const db = database.current;
      const wakes: unknown[] = [];
      await fixture();
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(
        db,
        {
          publish(hint) {
            wakes.push(hint);
          },
        },
        {
          availabilityMutations: availability,
        },
      );
      const measured = createWorkProjectionMutation({ db, availability, catalog });
      const scopeKey = catalogScopeKey({ kind: "project", projectId: PROJECT_ID });
      const [headBefore] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      const [otherBefore] = await db
        .select({ entry: contextCatalogEntries.entry })
        .from(contextCatalogEntries)
        .where(
          and(
            eq(contextCatalogEntries.scopeKey, scopeKey),
            eq(contextCatalogEntries.entryId, SECOND_WORK_ID),
          ),
        );
      const sequenceBefore = await db.execute<{ last_value: string }>(
        sql`select last_value::text from context_availability_generation_seq`,
      );
      const commitsBefore = await db
        .select({ commitId: contextCatalogCommits.commitId })
        .from(contextCatalogCommits)
        .where(eq(contextCatalogCommits.scopeKey, scopeKey));
      await runInDrizzleTransaction(db, async () => {
        await measured.touchWorks([WORK_ID]);
        await measured.touchWorks([SECOND_WORK_ID]);
        expect(wakes).toHaveLength(0);
      });
      const [headAfter] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      const [otherAfter] = await db
        .select({ entry: contextCatalogEntries.entry })
        .from(contextCatalogEntries)
        .where(
          and(
            eq(contextCatalogEntries.scopeKey, scopeKey),
            eq(contextCatalogEntries.entryId, SECOND_WORK_ID),
          ),
        );
      const sequenceAfter = await db.execute<{ last_value: string }>(
        sql`select last_value::text from context_availability_generation_seq`,
      );
      const commitsAfter = await db
        .select({
          commitId: contextCatalogCommits.commitId,
          changes: contextCatalogCommits.changes,
        })
        .from(contextCatalogCommits)
        .where(eq(contextCatalogCommits.scopeKey, scopeKey))
        .orderBy(contextCatalogCommits.firstRevision);
      expect(headAfter?.revision).toBe((headBefore?.revision ?? 0) + 1);
      expect(otherAfter?.entry).not.toEqual(otherBefore?.entry);
      expect(wakes).toHaveLength(1);
      expect(commitsAfter).toHaveLength(commitsBefore.length + 1);
      const lastChanges = commitsAfter.at(-1)?.changes ?? [];
      expect(
        lastChanges
          .flatMap((change) => (change.operation === "upsert" ? [change.entry.entryId] : []))
          .sort(),
      ).toEqual([SECOND_WORK_ID, WORK_ID].sort());
      expect(BigInt(sequenceAfter[0]?.last_value ?? "0")).toBe(
        BigInt(sequenceBefore[0]?.last_value ?? "0") + 1n,
      );
      expect((await projectionState()).entityRevision).toBe(2n);
    });
    it("discards failed savepoint Work state, merges successful state, and publishes once", async () => {
      const db = database.current;
      const wakes: unknown[] = [];
      await fixture();
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(
        db,
        {
          publish(hint) {
            wakes.push(hint);
          },
        },
        { availabilityMutations: availability },
      );
      const measured = createWorkProjectionMutation({ db, availability, catalog });
      const scopeKey = catalogScopeKey({ kind: "project", projectId: PROJECT_ID });
      const [headBefore] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      await runInDrizzleTransaction(db, async () => {
        await measured.touchWorks([WORK_ID]);
        await expect(
          runInDrizzleSavepoint(db, async () => {
            await measured.touchWorks([SECOND_WORK_ID]);
            throw new Error("failed child");
          }),
        ).rejects.toThrow("failed child");
        await measured.touchWorks([SECOND_WORK_ID]);
        await runInDrizzleSavepoint(db, () => measured.publishWorks([WORK_ID]));
        expect(wakes).toHaveLength(0);
      });
      const [headAfter] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      const revisions = await db
        .select({ id: works.id, revision: works.entityRevision })
        .from(works)
        .where(sql`${works.id} in (${WORK_ID}, ${SECOND_WORK_ID})`);
      expect(new Map(revisions.map((row) => [row.id, row.revision]))).toEqual(
        new Map([
          [WORK_ID, 2n],
          [SECOND_WORK_ID, 2n],
        ]),
      );
      expect(headAfter?.revision).toBe((headBefore?.revision ?? 0) + 1);
      expect(wakes).toHaveLength(1);
    });
    it("coalesces distinct real discard owners into one project publication", async () => {
      const db = database.current;
      const wakes: unknown[] = [];
      await fixture();
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(
        db,
        {
          publish(hint) {
            wakes.push(hint);
          },
        },
        { availabilityMutations: availability },
      );
      const projection = createWorkProjectionMutation({ db, availability, catalog });
      const branches = createDrizzleBranchStore(
        db,
        undefined,
        createBranchCriticalSections(),
        projection,
      );
      for (const branchId of [BRANCH_ID, OTHER_BRANCH_ID, SECOND_BRANCH_ID]) {
        await branches.appendJournal?.({
          branchId,
          generation: 1,
          updateData: new Uint8Array([1]),
          source: "agent",
          updateMeta: { kind: "edit" },
        });
      }
      wakes.length = 0;
      const scopeKey = catalogScopeKey({ kind: "project", projectId: PROJECT_ID });
      const [headBefore] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      const otherScopeKey = catalogScopeKey({ kind: "project", projectId: OTHER_PROJECT_ID });
      const [otherHeadBefore] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, otherScopeKey));
      const sequenceBefore = await db.execute<{ lastValue: string }>(
        sql`select last_value::text as "lastValue" from context_availability_generation_seq`,
      );
      const journal = createDrizzleBranchJournalReadStore(db);
      const pushStore = createDrizzlePushCommitStore(
        db,
        stagePendingSettlementWithinTx,
        createDrizzleChangeTrailAggregateWriter(db),
        undefined,
        projection,
      );
      const branchInputs = [
        { branchId: BRANCH_ID, documentId: DOCUMENT_ID, workId: WORK_ID },
        {
          branchId: OTHER_BRANCH_ID,
          documentId: OTHER_DOCUMENT_ID,
          workId: OTHER_WORK_ID,
        },
        {
          branchId: SECOND_BRANCH_ID,
          documentId: SECOND_DOCUMENT_ID,
          workId: SECOND_WORK_ID,
        },
      ];
      await runInDrizzleTransaction(db, async () => {
        for (const value of branchInputs) {
          await pushStore.commitDiscard({
            branch: {
              ...value,
              documentId: value.documentId as never,
              workId: value.workId as never,
              kind: "work_draft",
              upstreamBranchId: null,
              threadId: null,
              pushPolicy: "manual",
              generation: 1,
              status: "active",
              state: new Uint8Array([0]),
              stateVector: new Uint8Array([0]),
              schemaVersion: 1 as never,
            },
            journalRows: await journal.listReviewableJournalRows(value.branchId, 1),
            state: new Uint8Array([0]),
            stateVector: new Uint8Array([0]),
          });
        }
        expect(wakes).toHaveLength(0);
      });
      const [headAfter] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      const [otherHeadAfter] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, otherScopeKey));
      const sequenceAfter = await db.execute<{ lastValue: string }>(
        sql`select last_value::text as "lastValue" from context_availability_generation_seq`,
      );
      expect(headAfter?.revision).toBe((headBefore?.revision ?? 0) + 1);
      expect(otherHeadAfter?.revision).toBe((otherHeadBefore?.revision ?? 0) + 1);
      expect(wakes).toHaveLength(2);
      expect(BigInt(sequenceAfter[0]?.lastValue ?? "0")).toBe(
        BigInt(sequenceBefore[0]?.lastValue ?? "0") + 1n,
      );
      for (const { branchId } of branchInputs) {
        await expect(journal.listReviewableJournalRows(branchId, 1)).resolves.toEqual([]);
      }
    });
  });
}
