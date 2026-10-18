/**
 * The application mutation boundary for Works: the one owner of Work-first lock order for
 * every lifecycle or structural write that holds a Work's branch, draft or document row, which
 * is how those writes order themselves against the Work's lifecycle transitions, and the
 * canonical transaction participant for every mutation visible in a Works snapshot. It owns
 * the Work's stored pending count (the badge): every Work a transaction locks through it is
 * recounted at commit, and only a moved count bumps the Work's revision and sends a notice. An
 * ordinary draft append (a keystroke) never enters it: the draft-effect projection runs after
 * every append and recounts then, through `mutate`.
 */
import type { BranchId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branches, works } from "@meridian/database/schema";
import { and, inArray, ne, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  isInDrizzleTransaction,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { type BranchDraftRef, branchDraftRefs } from "../../../shared/work-branch-lifecycle.js";
import {
  type LockedWork,
  lockSeamWorks,
  lockWorksInIdOrder,
} from "../../../shared/work-lifecycle-lock.js";
import type { ProjectContextAvailabilityMutationPort } from "../../context/ports/project-context-availability.js";
import { WorkLifecycleUnavailableError } from "../domain/work-lifecycle.js";
import type { ContextCatalogLifecyclePort } from "../ports/context-catalog-lifecycle.js";
import type { WorkBranchPendingCounts } from "../ports/work-branch-pending-counts.js";

/** The Works a write names: directly, or through the branches and drafts it changes. */
export type WorkWriteSet = {
  works?: readonly WorkId[];
  branches?: readonly BranchId[];
  drafts?: readonly string[];
};

export type WorkWriteOptions = {
  /** With the bound edit grants' Works, then the grants' confirmation (file-access §5). */
  seam?: boolean;
  /**
   * Refuses unless every Work of the set is active: a named draft that doesn't exist is an
   * error, and one whose branch has no origin Work is frozen (`missing`).
   */
  requireActive?: boolean;
};

export type LockedWorkWriteSet = {
  /** Every locked Work's lifecycle, read under its lock. */
  works: ReadonlyMap<string, LockedWork>;
  /** Each named draft that exists, with its branch's Work (`null`: frozen). */
  drafts: readonly BranchDraftRef[];
};

export type WorkProjectionMutation = {
  notifyWorksChanged(workIds: readonly WorkId[]): Promise<void>;
  /** Activity on the Works (`lastActivityAt`): a revision and a notice, count or not. */
  touchWorks(workIds: readonly WorkId[], activityAt: Date): Promise<void>;
  /**
   * Work-first order: the set's Works locked `FOR NO KEY UPDATE` in id order, in the caller's
   * transaction, before it takes any draft, branch or document row. At commit each locked
   * Work's pending count is reconciled against its stored value, and a Work whose count moved
   * gets a revision and a notice; one whose count stayed gets neither. Apart from the Work's
   * own lifecycle writers, nothing else in collab or projects locks a Work for a write.
   */
  lockWorks(set: WorkWriteSet, options?: WorkWriteOptions): Promise<LockedWorkWriteSet>;
  /** `lockWorks`, then `operation`, in one transaction (its own when the caller has none). */
  mutate<T>(set: WorkWriteSet, operation: () => Promise<T>, options?: WorkWriteOptions): Promise<T>;
};

const WORKS_NOTICE_STATE = {};
type WorksNoticeState = {
  touchedWorkIds: Set<WorkId>;
  /** Works locked through the boundary: their pending count is reconciled once, at commit. */
  reconcileWorkIds: Set<WorkId>;
  pendingWorkIdsByProject: Map<string, Set<WorkId>>;
};

export function createWorkProjectionMutation(input: {
  db: Database;
  availability: Pick<ProjectContextAvailabilityMutationPort, "advance">;
  catalog: ContextCatalogLifecyclePort;
  /** The collab-owned pending membership rule, counted per Work in SQL. */
  pendingCounts: WorkBranchPendingCounts;
}): WorkProjectionMutation {
  const worksNoticeParticipant: DrizzleTransactionParticipant<WorksNoticeState> = {
    key: WORKS_NOTICE_STATE,
    create: () => ({
      touchedWorkIds: new Set(),
      reconcileWorkIds: new Set(),
      pendingWorkIdsByProject: new Map(),
    }),
    fork: (parent) => ({
      touchedWorkIds: new Set(parent.touchedWorkIds),
      reconcileWorkIds: new Set(parent.reconcileWorkIds),
      pendingWorkIdsByProject: new Map(
        [...parent.pendingWorkIdsByProject].map(([projectId, workIds]) => [
          projectId,
          new Set(workIds),
        ]),
      ),
    }),
    merge(parent, child) {
      for (const workId of child.touchedWorkIds) parent.touchedWorkIds.add(workId);
      for (const workId of child.reconcileWorkIds) parent.reconcileWorkIds.add(workId);
      for (const [projectId, childWorkIds] of child.pendingWorkIdsByProject) {
        const parentWorkIds = parent.pendingWorkIdsByProject.get(projectId) ?? new Set<WorkId>();
        for (const workId of childWorkIds) parentWorkIds.add(workId);
        parent.pendingWorkIdsByProject.set(projectId, parentWorkIds);
      }
      return parent;
    },
    async beforeCommit(state) {
      await reconcilePendingCounts(state);
      if (state.pendingWorkIdsByProject.size === 0) return;
      const projectIds = [...state.pendingWorkIdsByProject.keys()].sort();
      const workIds = projectIds.flatMap((projectId) => [
        ...(state.pendingWorkIdsByProject.get(projectId) ?? []),
      ]);
      await input.availability.advance({ projectIds, userIds: [] });
      await input.catalog.upsertWorkAuthorities(workIds);
    },
  };

  function worksNoticeState(): WorksNoticeState {
    return enlistDrizzleTransactionParticipant(worksNoticeParticipant);
  }

  function enrollRows(
    state: WorksNoticeState,
    rows: readonly { id: string; projectId: string }[],
  ): void {
    for (const { id, projectId } of rows) {
      const projectWorkIds = state.pendingWorkIdsByProject.get(projectId) ?? new Set<WorkId>();
      projectWorkIds.add(id as WorkId);
      state.pendingWorkIdsByProject.set(projectId, projectWorkIds);
    }
  }

  async function enrollWorksNotice(workIds: readonly WorkId[]): Promise<void> {
    const unique = [...new Set(workIds)].sort() as WorkId[];
    const rows = await currentDrizzleDb(input.db)
      .select({ id: works.id, projectId: works.projectId })
      .from(works)
      .where(inArray(works.id, unique));
    enrollRows(worksNoticeState(), rows);
  }

  /**
   * Under the Work locks `lockWriteSet` took, which serialize reconciles of one Work: counts once
   * per transaction, however many writes it made, and writes only a count that moved. An
   * append that commits after the count is not lost: it schedules the draft-effect
   * projection, whose `mutate` reconciles again; the stored value, not a count taken before
   * this transaction's own writes, is what that compares against.
   */
  async function reconcilePendingCounts(state: WorksNoticeState): Promise<void> {
    if (state.reconcileWorkIds.size === 0) return;
    const workIds = [...state.reconcileWorkIds].sort() as WorkId[];
    state.reconcileWorkIds.clear();
    const counts = await input.pendingCounts.countPendingByWorkIds(workIds);
    const count = sql`(case ${works.id} ${sql.join(
      workIds.map((workId) => sql`when ${workId}::uuid then ${counts.get(workId) ?? 0}::integer`),
      sql` `,
    )} end)`;
    const moved = await currentDrizzleDb(input.db)
      .update(works)
      .set({ pendingDocumentCount: count, entityRevision: sql`${works.entityRevision} + 1` })
      .where(and(inArray(works.id, workIds), ne(works.pendingDocumentCount, count)))
      .returning({ id: works.id, projectId: works.projectId });
    enrollRows(state, moved);
  }

  async function lockWriteSet(
    set: WorkWriteSet,
    options: WorkWriteOptions = {},
  ): Promise<LockedWorkWriteSet> {
    if (!isInDrizzleTransaction()) {
      throw new Error("Work locks are held by the caller's transaction; none is open");
    }
    const draftIds = new Set(set.drafts ?? []);
    const drafts = await branchDraftRefs(input.db, [...draftIds]);
    if (options.requireActive) {
      if (drafts.length !== draftIds.size) throw new Error("Draft not found");
      // A draft whose branch has no origin Work is frozen, as a missing Work is.
      const frozen = drafts.find((row) => row.workId === null);
      if (frozen) throw new WorkLifecycleUnavailableError(frozen.branchId, "missing");
    }
    const branchIds = [...new Set(set.branches ?? [])];
    // A branch's Work is its origin Work, as the pending projection maps a branch.
    const branchWorks =
      branchIds.length === 0
        ? []
        : await currentDrizzleDb(input.db)
            .select({ workId: branches.originWorkId })
            .from(branches)
            .where(inArray(branches.id, branchIds));
    const workIds = [
      ...new Set([
        ...(set.works ?? []),
        ...branchWorks.flatMap(({ workId }) => (workId ? [workId as WorkId] : [])),
        ...drafts.flatMap((row) => (row.workId ? [row.workId] : [])),
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
    // Whatever the caller changes under these locks, the count follows at commit.
    const state = worksNoticeState();
    for (const workId of workIds) state.reconcileWorkIds.add(workId);
    return { works: locked, drafts };
  }

  const mutation: WorkProjectionMutation = {
    async notifyWorksChanged(workIds) {
      await runInDrizzleTransaction(input.db, () => enrollWorksNotice(workIds));
    },
    async touchWorks(workIds, activityAt) {
      await runInDrizzleTransaction(input.db, async () => {
        const state = worksNoticeState();
        const unique = [...new Set(workIds)].sort() as WorkId[];
        const untouched = unique.filter((workId) => !state.touchedWorkIds.has(workId));
        if (untouched.length === 0) return;
        const rows = await currentDrizzleDb(input.db)
          .update(works)
          .set({ entityRevision: sql`${works.entityRevision} + 1`, updatedAt: activityAt })
          .where(inArray(works.id, untouched))
          .returning({ id: works.id, projectId: works.projectId });
        for (const { id } of rows) state.touchedWorkIds.add(id as WorkId);
        enrollRows(state, rows);
      });
    },
    lockWorks: lockWriteSet,
    /**
     * The set's Works locked before `operation` takes any branch or draft row, so every
     * structural draft write enters Work, then branch, then draft, the order Archive takes
     * (decision D12).
     */
    mutate(set, operation, options) {
      return runInDrizzleTransaction(input.db, async () => {
        await lockWriteSet(set, options);
        return operation();
      });
    },
  };
  return mutation;
}
