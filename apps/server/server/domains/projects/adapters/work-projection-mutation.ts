/**
 * The application mutation boundary for Works: the one owner of Work-first lock order for
 * every lifecycle or structural write that holds a Work's draft, branch or document row, which
 * is how those writes order themselves against the Work's lifecycle transitions, and the
 * canonical transaction participant for every mutation visible in a Works snapshot. An
 * ordinary branch append (a keystroke) never enters it: the draft-effect projection publishes
 * the Work's badge afterwards, independently, through `mutate`.
 */
import type { DraftId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { drafts, works } from "@meridian/database/schema";
import { inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  isInDrizzleTransaction,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { type DraftBranchWork, draftBranchWorks } from "../../../shared/work-draft-lifecycle.js";
import {
  type LockedWork,
  lockSeamWorks,
  lockWorksInIdOrder,
} from "../../../shared/work-lifecycle-lock.js";
import type { ProjectContextAvailabilityMutationPort } from "../../context/ports/project-context-availability.js";
import { WorkLifecycleUnavailableError } from "../domain/work-lifecycle.js";
import type { ContextCatalogLifecyclePort } from "../ports/context-catalog-lifecycle.js";

/** The Works a write names: directly, or through the drafts and branches it changes. */
export type WorkWriteSet = {
  works?: readonly WorkId[];
  drafts?: readonly DraftId[];
  branches?: readonly string[];
};

export type WorkWriteOptions = {
  /** With the bound edit grants' Works, then the grants' confirmation (file-access §5). */
  seam?: boolean;
  /**
   * Refuses unless every Work of the set is active: a named branch that doesn't exist is an
   * error, and one whose draft has no origin Work is frozen (`missing`).
   */
  requireActive?: boolean;
};

export type LockedWorkWriteSet = {
  /** Every locked Work's lifecycle, read under its lock. */
  works: ReadonlyMap<string, LockedWork>;
  /** Each named branch that exists, with its draft's Work (`null`: frozen). */
  branches: readonly DraftBranchWork[];
};

export type WorkProjectionMutation = {
  publishWorks(workIds: readonly WorkId[]): Promise<void>;
  touchWorks(workIds: readonly WorkId[], activityAt?: Date): Promise<void>;
  /**
   * Work-first order alone: the set's Works locked `FOR NO KEY UPDATE` in id order, in the
   * caller's transaction, before it takes any draft, branch or document row. Apart from the
   * Work's own lifecycle writers, nothing else in collab or projects locks a Work for a write.
   */
  lockWorks(set: WorkWriteSet, options?: WorkWriteOptions): Promise<LockedWorkWriteSet>;
  /**
   * The set's Works locked first, then `operation`, then every resolved Work touched: the
   * write set is the invalidation set. A Work whose pending count `operation` left unchanged
   * still gets a revision and a publication, which costs less than counting before and after;
   * the count itself stays a read-model concern (`list-work-catalog.ts`).
   */
  mutate<T>(set: WorkWriteSet, operation: () => Promise<T>, options?: WorkWriteOptions): Promise<T>;
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

  async function lockWriteSet(
    set: WorkWriteSet,
    options: WorkWriteOptions = {},
  ): Promise<LockedWorkWriteSet & { workIds: WorkId[] }> {
    if (!isInDrizzleTransaction()) {
      throw new Error("Work locks are held by the caller's transaction; none is open");
    }
    const branchIds = new Set(set.branches ?? []);
    const branches = await draftBranchWorks(input.db, [...branchIds]);
    if (options.requireActive) {
      if (branches.length !== branchIds.size) throw new Error("Draft branch not found");
      // A draft whose origin Work is gone is frozen, as a missing Work is.
      const frozen = branches.find((row) => row.workId === null);
      if (frozen) throw new WorkLifecycleUnavailableError(frozen.draftId, "missing");
    }
    const draftIds = [...new Set(set.drafts ?? [])];
    // A draft's Work is its origin Work, as the pending projection maps a draft.
    const draftWorks =
      draftIds.length === 0
        ? []
        : await currentDrizzleDb(input.db)
            .select({ workId: drafts.originWorkId })
            .from(drafts)
            .where(inArray(drafts.id, draftIds));
    const workIds = [
      ...new Set([
        ...(set.works ?? []),
        ...draftWorks.flatMap(({ workId }) => (workId ? [workId as WorkId] : [])),
        ...branches.flatMap((row) => (row.workId ? [row.workId] : [])),
      ]),
    ].sort() as WorkId[];
    const db = currentDrizzleDb(input.db);
    const locked = options.seam
      ? await lockSeamWorks(db, workIds)
      : await lockWorksInIdOrder(db, workIds);
    if (options.requireActive) {
      for (const workId of workIds) {
        const work = locked.get(workId);
        if (work && work.state !== "active") {
          throw new WorkLifecycleUnavailableError(workId, work.state, work.slug);
        }
      }
    }
    return { works: locked, branches, workIds };
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
    async lockWorks(set, options) {
      const { works: locked, branches } = await lockWriteSet(set, options);
      return { works: locked, branches };
    },
    /**
     * The set's Works locked before `operation` takes any draft or branch row, so every
     * structural branch write enters Work, then draft, then branch, the order Archive takes
     * (decision D12).
     */
    mutate(set, operation, options) {
      return runInDrizzleTransaction(input.db, async () => {
        const { workIds } = await lockWriteSet(set, options);
        const result = await operation();
        await mutation.touchWorks(workIds);
        return result;
      });
    },
  };
  return mutation;
}
