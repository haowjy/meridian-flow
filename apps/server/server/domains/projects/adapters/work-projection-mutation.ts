/** Canonical transaction participant for every mutation visible in a Works snapshot. */
import type { DraftId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { drafts, works } from "@meridian/database/schema";
import { inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { draftBranchWorks } from "../../../shared/work-draft-lifecycle.js";
import type { ProjectContextAvailabilityMutationPort } from "../../context/ports/project-context-availability.js";
import type { ContextCatalogLifecyclePort } from "../ports/context-catalog-lifecycle.js";
import type { WorkDraftPendingCounts } from "../ports/work-draft-pending-counts.js";

export type WorkProjectionMutation = {
  publishWorks(workIds: readonly WorkId[]): Promise<void>;
  touchWorks(workIds: readonly WorkId[], activityAt?: Date): Promise<void>;
  /** Enrolls the Works whose pending count `operation` changed, by these branches' drafts. */
  mutatePendingBranches<T>(branchIds: readonly string[], operation: () => Promise<T>): Promise<T>;
  /**
   * The same for a change to these drafts' tree rows or branches (contract §13.2): a
   * branchless image create or an empty tracked create moves the Work's badge too.
   */
  mutatePendingDraft<T>(draftIds: readonly DraftId[], operation: () => Promise<T>): Promise<T>;
};

const PUBLICATION_STATE = {};
type PublicationState = {
  touchedWorkIds: Set<WorkId>;
  pendingWorkIdsByProject: Map<string, Set<WorkId>>;
};

export function createWorkProjectionMutation(input: {
  db: Database;
  availability: Pick<ProjectContextAvailabilityMutationPort, "advance">;
  catalog: ContextCatalogLifecyclePort;
  /** Read in the caller's transaction, so before and after count what the list and catalog do. */
  pending: WorkDraftPendingCounts;
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

  /** Before and after `operation`, these Works' pending counts; touch those that moved. */
  async function enrollPendingChange<T>(
    workIds: readonly WorkId[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const unique = [...new Set(workIds)].sort() as WorkId[];
    if (unique.length === 0) return operation();
    const before = await input.pending.countPendingByWorkIds(unique);
    const result = await operation();
    const after = await input.pending.countPendingByWorkIds(unique);
    await mutation.touchWorks(
      unique.filter((workId) => (before.get(workId) ?? 0) !== (after.get(workId) ?? 0)),
    );
    return result;
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
        const mapped = await draftBranchWorks(input.db, branchIds);
        return enrollPendingChange(
          mapped.flatMap(({ workId }) => (workId ? [workId] : [])),
          operation,
        );
      });
    },
    async mutatePendingDraft(draftIds, operation) {
      return runInDrizzleTransaction(input.db, async () => {
        const ids = [...new Set(draftIds)];
        const rows =
          ids.length === 0
            ? []
            : await currentDrizzleDb(input.db)
                .select({ workId: drafts.originWorkId })
                .from(drafts)
                .where(inArray(drafts.id, ids));
        return enrollPendingChange(
          rows.flatMap(({ workId }) => (workId ? [workId as WorkId] : [])),
          operation,
        );
      });
    },
  };
  return mutation;
}
