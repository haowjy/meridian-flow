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
import { draftOwnerKey } from "@meridian/contracts";
import type { DraftOwnerHint } from "@meridian/contracts/protocol";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branches, works } from "@meridian/database/schema";
import { and, inArray, ne, sql } from "drizzle-orm";
import {
  type BranchDraftRef,
  branchDraftRefs,
  LineageDraftsUnavailableError,
  lockLineageOwners,
  type OwnerLocks,
} from "../../../shared/draft-owner.js";
import {
  currentDrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  isInDrizzleTransaction,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import {
  type LockedWork,
  lockSeamWorks,
  lockWorksInIdOrder,
} from "../../../shared/work-lifecycle-lock.js";
import type { ProjectHintPort } from "../../context/ports/project-hints.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { WorkLifecycleUnavailableError } from "../domain/work-lifecycle.js";
import type { WorkBranchPendingCounts } from "../ports/work-branch-pending-counts.js";

/**
 * The owners a write names: directly, or through the branches and drafts it changes. A lineage
 * is named by its root thread id.
 */
export type WorkWriteSet = {
  works?: readonly WorkId[];
  lineages?: readonly string[];
  branches?: readonly BranchId[];
  drafts?: readonly string[];
};

export type WorkWriteOptions = {
  /** With the bound edit grants' Works, then the grants' confirmation (file-access §5). */
  seam?: boolean;
  /**
   * Refuses unless every Work and lineage of the set is active: a named draft that doesn't
   * exist is an error, and one whose branch has no owner is frozen (`missing`).
   */
  requireActive?: boolean;
  /** With `requireActive`: a lineage with no live member still passes, so Discard can clear it. */
  allowFrozenLineage?: boolean;
};

export type LockedWorkWriteSet = {
  /** Every locked Work's lifecycle, read under its lock. */
  works: ReadonlyMap<string, LockedWork>;
  /** Every locked lineage's liveness, read under its lock. */
  lineages: ReadonlyMap<string, "active" | "frozen">;
  /** Each named draft that exists, with its branch's owner (neither set: frozen). */
  drafts: readonly BranchDraftRef[];
};

export type WorkProjectionMutation = {
  /** Activity on the Works (`lastActivityAt`): a revision and a notice, count or not. */
  touchWorks(workIds: readonly WorkId[], activityAt: Date): Promise<void>;
  /**
   * Owner-first order: the set's Works locked `FOR NO KEY UPDATE` in id order, then its
   * lineages' draft-owner locks in root order, in the caller's transaction, before it takes any
   * draft, branch or document row. At commit each locked owner's branches are recounted and
   * stored; a Work whose total moved gets a revision, and it and every branch whose count moved
   * wake their owner with a `draft-owner-hint`; unmoved counts get neither. Apart from the owners'
   * own lifecycle writers, nothing else in collab or projects locks an owner for a write.
   */
  lockWorks(set: WorkWriteSet, options?: WorkWriteOptions): Promise<LockedWorkWriteSet>;
  /** `lockWorks`, then `operation`, in one transaction (its own when the caller has none). */
  mutate<T>(set: WorkWriteSet, operation: () => Promise<T>, options?: WorkWriteOptions): Promise<T>;
  /**
   * Works whose pending count the caller's transaction changed without holding them (it is
   * past Work-first order): each is recounted in a root transaction of its own once the caller
   * commits, unless the caller already locked it through this boundary.
   */
  recountAfterCommit(owners: OwnerLocks): void;
  /**
   * The Work was archived, unarchived, deleted, restored or purged: once the caller commits, the
   * Work's `draft-owner-hint` goes out, as for a count that moved, so the Works list and the
   * Work's drafts list are read again.
   */
  lifecycleChanged(work: { id: WorkId; projectId: string }): void;
};

const WORKS_NOTICE_STATE = {};
type WorksNoticeState = {
  touchedWorkIds: Set<WorkId>;
  /** Works locked through the boundary: their pending count is reconciled once, at commit. */
  reconcileWorkIds: Set<WorkId>;
  /** Lineages locked through the boundary: their branches' counts are reconciled at commit. */
  reconcileRootIds: Set<string>;
  /** Owners changed but not locked: recounted after commit unless locked by then. */
  recountWorkIds: Set<WorkId>;
  recountRootIds: Set<string>;
};

export function createWorkProjectionMutation(input: {
  db: Database;
  draftOwnerHints: Pick<ProjectHintPort, "publishDraftOwnerHints">;
  /** The collab-owned pending membership rule, counted per Work in SQL. */
  pendingCounts: WorkBranchPendingCounts;
  eventSink?: EventSink;
}): WorkProjectionMutation {
  const worksNoticeParticipant: DrizzleTransactionParticipant<WorksNoticeState> = {
    key: WORKS_NOTICE_STATE,
    create: () => ({
      touchedWorkIds: new Set(),
      reconcileWorkIds: new Set(),
      reconcileRootIds: new Set(),
      recountWorkIds: new Set(),
      recountRootIds: new Set(),
    }),
    fork: (parent) => ({
      touchedWorkIds: new Set(parent.touchedWorkIds),
      reconcileWorkIds: new Set(parent.reconcileWorkIds),
      reconcileRootIds: new Set(parent.reconcileRootIds),
      recountWorkIds: new Set(parent.recountWorkIds),
      recountRootIds: new Set(parent.recountRootIds),
    }),
    merge(parent, child) {
      for (const workId of child.touchedWorkIds) parent.touchedWorkIds.add(workId);
      for (const workId of child.reconcileWorkIds) parent.reconcileWorkIds.add(workId);
      for (const root of child.reconcileRootIds) parent.reconcileRootIds.add(root);
      for (const workId of child.recountWorkIds) parent.recountWorkIds.add(workId);
      for (const root of child.recountRootIds) parent.recountRootIds.add(root);
      return parent;
    },
    async beforeCommit(state) {
      const unlocked = [...state.recountWorkIds].filter((id) => !state.reconcileWorkIds.has(id));
      const unlockedRoots = [...state.recountRootIds].filter(
        (root) => !state.reconcileRootIds.has(root),
      );
      if (unlocked.length || unlockedRoots.length)
        runAfterDrizzleCommit(() => recountInRoot(unlocked.sort(), unlockedRoots.sort()));
      await reconcilePendingCounts(state);
    },
  };

  async function recountInRoot(workIds: WorkId[], lineages: string[]): Promise<void> {
    try {
      await runInRootDrizzleTransaction(input.db, () =>
        mutation.mutate({ works: workIds, lineages }, async () => undefined),
      );
    } catch (error) {
      // The next mutation of these Works reconciles their counts again.
      if (input.eventSink)
        emitEvent(input.eventSink, {
          level: "error",
          source: "projects.work_projection",
          name: "recount.failed",
          payload: { workIds, lineages, ...unknownToEventPayload(error) },
        });
    }
  }

  function worksNoticeState(): WorksNoticeState {
    return enlistDrizzleTransactionParticipant(worksNoticeParticipant);
  }

  /**
   * Under the owner locks `lockWriteSet` took, which serialize reconciles of one owner: counts
   * once per transaction, however many writes it made, and writes only a count that moved. An
   * append that commits after the count is not lost: it schedules the draft-effect
   * projection, whose `mutate` reconciles again; the stored value, not a count taken before
   * this transaction's own writes, is what that compares against.
   */
  async function reconcilePendingCounts(state: WorksNoticeState): Promise<void> {
    if (state.reconcileWorkIds.size === 0 && state.reconcileRootIds.size === 0) return;
    const workIds = [...state.reconcileWorkIds].sort() as WorkId[];
    const rootThreadIds = [...state.reconcileRootIds].sort();
    state.reconcileWorkIds.clear();
    state.reconcileRootIds.clear();
    const tx = currentDrizzleDb(input.db);
    const branchCounts = await input.pendingCounts.countPendingByOwners({ workIds, rootThreadIds });
    // Each owner whose list gained or lost a document is woken once: a branch whose count moved,
    // and a Work whose total moved (a whole Discard closes the branch, which then counts nowhere).
    // A draft joins the list when the effect projection judges it, after the write that made it.
    const hints = new Map<string, DraftOwnerHint>();
    const wake = (projectId: DraftOwnerHint["projectId"], owner: DraftOwnerHint["owner"]) =>
      hints.set(owner, { type: "draft-owner-hint", projectId, owner });
    if (branchCounts.length) {
      const counts = sql`(case ${branches.id} ${sql.join(
        branchCounts.map(
          ({ branchId, count }) => sql`when ${branchId}::uuid then ${count}::integer`,
        ),
        sql` `,
      )} end)`;
      const movedBranches = new Set(
        (
          await tx
            .update(branches)
            .set({ pendingDocumentCount: counts })
            .where(
              and(
                inArray(
                  branches.id,
                  branchCounts.map(({ branchId }) => branchId),
                ),
                ne(branches.pendingDocumentCount, counts),
              ),
            )
            .returning({ id: branches.id })
        ).map(({ id }) => id as string),
      );
      for (const row of branchCounts)
        if (movedBranches.has(row.branchId))
          wake(
            row.projectId,
            row.rootThreadId
              ? draftOwnerKey({ kind: "lineage", rootThreadId: row.rootThreadId })
              : draftOwnerKey({ kind: "work", workId: row.workId as string }),
          );
    }
    if (workIds.length > 0) {
      // A Work's total is the sum over its active branches.
      const totals = new Map<string, number>();
      for (const row of branchCounts)
        if (row.workId) totals.set(row.workId, (totals.get(row.workId) ?? 0) + row.count);
      const count = sql`(case ${works.id} ${sql.join(
        workIds.map((workId) => sql`when ${workId}::uuid then ${totals.get(workId) ?? 0}::integer`),
        sql` `,
      )} end)`;
      const movedWorks = await tx
        .update(works)
        .set({ pendingDocumentCount: count, entityRevision: sql`${works.entityRevision} + 1` })
        .where(and(inArray(works.id, workIds), ne(works.pendingDocumentCount, count)))
        .returning({ id: works.id, projectId: works.projectId });
      for (const work of movedWorks)
        wake(work.projectId, draftOwnerKey({ kind: "work", workId: work.id }));
    }
    input.draftOwnerHints.publishDraftOwnerHints([...hints.values()]);
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
      // A draft whose branch has no owner is frozen, as a missing Work is.
      const frozen = drafts.find((row) => row.workId === null && row.rootThreadId === null);
      if (frozen) throw new WorkLifecycleUnavailableError(frozen.branchId, "missing");
    }
    const branchIds = [...new Set(set.branches ?? [])];
    // A branch's owner is its origin columns, as the pending projection maps a branch.
    const branchOwners =
      branchIds.length === 0
        ? []
        : await currentDrizzleDb(input.db)
            .select({ workId: branches.originWorkId, rootThreadId: branches.originRootThreadId })
            .from(branches)
            .where(inArray(branches.id, branchIds));
    const owned = [...drafts, ...branchOwners];
    const workIds = [
      ...new Set([
        ...(set.works ?? []),
        ...owned.flatMap(({ workId }) => (workId ? [workId as WorkId] : [])),
      ]),
    ].sort() as WorkId[];
    const rootIds = [
      ...new Set([
        ...(set.lineages ?? []),
        ...owned.flatMap(({ rootThreadId }) => (rootThreadId ? [rootThreadId] : [])),
      ]),
    ].sort();
    const db = currentDrizzleDb(input.db);
    const locked = options.seam
      ? await lockSeamWorks(db, workIds, rootIds)
      : {
          works: await lockWorksInIdOrder(db, workIds),
          lineages: await lockLineageOwners(db, rootIds),
        };
    if (options.requireActive) {
      for (const workId of workIds) {
        const work = locked.works.get(workId);
        if (work && work.state !== "active") {
          throw new WorkLifecycleUnavailableError(workId, work.state, work.handle);
        }
      }
      for (const root of rootIds) {
        if (!options.allowFrozenLineage && locked.lineages.get(root) !== "active") {
          throw new LineageDraftsUnavailableError(root);
        }
      }
    }
    // Whatever the caller changes under these locks, the counts follow at commit.
    const state = worksNoticeState();
    for (const workId of workIds) state.reconcileWorkIds.add(workId);
    for (const root of rootIds) state.reconcileRootIds.add(root);
    return { ...locked, drafts };
  }

  const mutation: WorkProjectionMutation = {
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
          .returning({ id: works.id });
        for (const { id } of rows) state.touchedWorkIds.add(id as WorkId);
      });
    },
    lockWorks: lockWriteSet,
    recountAfterCommit({ workIds, lineageRootIds }) {
      if (!workIds.length && !lineageRootIds.length) return;
      const state = worksNoticeState();
      for (const workId of workIds) state.recountWorkIds.add(workId as WorkId);
      for (const root of lineageRootIds) state.recountRootIds.add(root);
    },
    lifecycleChanged(work) {
      input.draftOwnerHints.publishDraftOwnerHints([
        {
          type: "draft-owner-hint",
          projectId: work.projectId,
          owner: draftOwnerKey({ kind: "work", workId: work.id }),
        },
      ]);
    },
    /**
     * The set's Works locked before `operation` takes any branch or draft row, so every
     * structural draft write enters Work, then branch, then draft, the order Archive takes.
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
