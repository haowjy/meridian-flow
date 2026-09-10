/** Canonical transaction participant for every mutation visible in a Works snapshot. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branchWriteJournal, documentBranches, works } from "@meridian/database/schema";
import { and, countDistinct, eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { ProjectContextAvailabilityMutationPort } from "../../context/ports/project-context-availability.js";
import type { ContextCatalogLifecyclePort } from "../ports/context-catalog-lifecycle.js";

export type WorkProjectionMutation = {
  publishWorks(workIds: readonly WorkId[]): Promise<void>;
  touchWorks(workIds: readonly WorkId[], activityAt?: Date): Promise<void>;
  mutatePendingBranches<T>(branchIds: readonly string[], operation: () => Promise<T>): Promise<T>;
};

const PUBLICATION_STATE = {};
type PublicationState = {
  touchedWorkIds: Set<WorkId>;
  pendingWorkIdsByProject: Map<string, Set<WorkId>>;
};

export function createWorkProjectionMutation(input: {
  db: Database;
  availability: ProjectContextAvailabilityMutationPort;
  catalog: ContextCatalogLifecyclePort;
}): WorkProjectionMutation {
  const publicationParticipant: DrizzleTransactionParticipant<PublicationState> = {
    key: PUBLICATION_STATE,
    create: () => ({ touchedWorkIds: new Set(), pendingWorkIdsByProject: new Map() }),
    fork: (parent) => ({
      touchedWorkIds: new Set(parent.touchedWorkIds),
      pendingWorkIdsByProject: new Map(
        [...parent.pendingWorkIdsByProject].map(([projectId, workIds]) => [
          projectId,
          new Set(workIds),
        ]),
      ),
    }),
    merge(parent, child) {
      for (const workId of child.touchedWorkIds) parent.touchedWorkIds.add(workId);
      for (const [projectId, childWorkIds] of child.pendingWorkIdsByProject) {
        const parentWorkIds = parent.pendingWorkIdsByProject.get(projectId) ?? new Set<WorkId>();
        for (const workId of childWorkIds) parentWorkIds.add(workId);
        parent.pendingWorkIdsByProject.set(projectId, parentWorkIds);
      }
      return parent;
    },
    async beforeCommit(state) {
      if (state.pendingWorkIdsByProject.size === 0) return;
      const projectIds = [...state.pendingWorkIdsByProject.keys()].sort();
      const workIds = projectIds.flatMap((projectId) => [
        ...(state.pendingWorkIdsByProject.get(projectId) ?? []),
      ]);
      await input.availability.advance({ projectIds, userIds: [] });
      await input.catalog.upsertWorkAuthorities(workIds);
    },
  };

  function publicationState(): PublicationState {
    return enlistDrizzleTransactionParticipant(publicationParticipant);
  }

  async function enrollPublication(workIds: readonly WorkId[]): Promise<void> {
    const state = publicationState();
    const unique = [...new Set(workIds)].sort() as WorkId[];
    const rows = await currentDrizzleDb(input.db)
      .select({ id: works.id, projectId: works.projectId })
      .from(works)
      .where(inArray(works.id, unique));
    for (const { id, projectId } of rows) {
      const projectWorkIds = state.pendingWorkIdsByProject.get(projectId) ?? new Set<WorkId>();
      projectWorkIds.add(id as WorkId);
      state.pendingWorkIdsByProject.set(projectId, projectWorkIds);
    }
  }

  async function pendingCounts(workIds: readonly WorkId[]): Promise<Map<WorkId, number>> {
    if (workIds.length === 0) return new Map();
    const rows = await currentDrizzleDb(input.db)
      .select({ workId: documentBranches.workId, count: countDistinct(documentBranches.id) })
      .from(documentBranches)
      .innerJoin(
        branchWriteJournal,
        and(
          eq(branchWriteJournal.branchId, documentBranches.id),
          eq(branchWriteJournal.generation, documentBranches.generation),
          inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
        ),
      )
      .where(
        and(
          inArray(documentBranches.workId, workIds),
          eq(documentBranches.kind, "work_draft"),
          eq(documentBranches.status, "active"),
          sql`(${branchWriteJournal.updateMeta}->>'kind') is distinct from 'manifest_membership'
            or jsonb_typeof(${branchWriteJournal.updateMeta}->'documentId') is distinct from 'string'`,
        ),
      )
      .groupBy(documentBranches.workId);
    return new Map(
      rows.flatMap(({ workId, count }) =>
        workId === null ? [] : [[workId as WorkId, Number(count)] as const],
      ),
    );
  }

  const mutation: WorkProjectionMutation = {
    async publishWorks(workIds) {
      await runInDrizzleTransaction(input.db, () => enrollPublication(workIds));
    },
    async touchWorks(workIds, activityAt) {
      await runInDrizzleTransaction(input.db, async () => {
        const state = publicationState();
        const unique = [...new Set(workIds)].sort() as WorkId[];
        const untouched = unique.filter((workId) => !state.touchedWorkIds.has(workId));
        if (untouched.length === 0) return;
        const rows = await currentDrizzleDb(input.db)
          .update(works)
          .set({
            entityRevision: sql`${works.entityRevision} + 1`,
            ...(activityAt ? { updatedAt: activityAt } : {}),
          })
          .where(inArray(works.id, untouched))
          .returning({ id: works.id });
        for (const { id } of rows) state.touchedWorkIds.add(id as WorkId);
        await enrollPublication(rows.map(({ id }) => id as WorkId));
      });
    },
    async mutatePendingBranches(branchIds, operation) {
      return runInDrizzleTransaction(input.db, async () => {
        const unique = [...new Set(branchIds)].sort();
        if (unique.length === 0) return operation();
        const branchRows = await currentDrizzleDb(input.db)
          .select({ workId: documentBranches.workId })
          .from(documentBranches)
          .where(inArray(documentBranches.id, unique));
        const workIds = [
          ...new Set(branchRows.flatMap(({ workId }) => (workId ? [workId] : []))),
        ].sort() as WorkId[];
        const before = await pendingCounts(workIds);
        const result = await operation();
        const after = await pendingCounts(workIds);
        await mutation.touchWorks(
          workIds.filter((workId) => (before.get(workId) ?? 0) !== (after.get(workId) ?? 0)),
        );
        return result;
      });
    },
  };
  return mutation;
}
