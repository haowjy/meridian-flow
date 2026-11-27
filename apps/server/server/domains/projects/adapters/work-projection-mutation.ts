import type { DraftId } from "@meridian/contracts";
import type { DraftHint } from "@meridian/contracts/protocol";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { drafts, works } from "@meridian/database/schema";
import { type AnyColumn, and, inArray, ne, or, sql } from "drizzle-orm";
import {
  draftOwnerSql,
  LineageDraftsUnavailableError,
  lockLineageOwners,
  type OwnerLocks,
  workDefaultDraftSql,
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
  WorkLifecycleUnavailableError,
} from "../../../shared/work-lifecycle-lock.js";
import type { ProjectHintPort } from "../../context/ports/project-hints.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { WorkDraftPendingCounts } from "../ports/work-draft-pending-counts.js";

export type WorkWriteSet = {
  works?: readonly WorkId[];
  lineages?: readonly string[];
  drafts?: readonly DraftId[];
};

export type WorkWriteOptions = {
  seam?: boolean;
  requireActive?: boolean;
};

export type LockedWorkWriteSet = {
  works: ReadonlyMap<string, LockedWork>;
  lineages: ReadonlyMap<string, "active" | "frozen">;
};

export type WorkProjectionMutation = {
  touchWorks(workIds: readonly WorkId[], activityAt: Date): Promise<void>;
  lockWorks(set: WorkWriteSet, options?: WorkWriteOptions): Promise<LockedWorkWriteSet>;
  ownersOf(set: WorkWriteSet): Promise<OwnerLocks>;
  mutate<T>(
    set: WorkWriteSet,
    operation: (locked: LockedWorkWriteSet) => Promise<T>,
    options?: WorkWriteOptions,
  ): Promise<T>;
  recountAfterCommit(owners: OwnerLocks): void;
  lifecycleChanged(work: { id: WorkId; projectId: string; draftId: string | null }): void;
  liveChangedUnder(draftIds: readonly string[]): void;
};

const WORKS_NOTICE_STATE = {};
type WorksNoticeState = {
  touchedWorkIds: Set<WorkId>;
  reconcileWorkIds: Set<WorkId>;
  reconcileRootIds: Set<string>;
  recountWorkIds: Set<WorkId>;
  recountRootIds: Set<string>;
  wakeDraftIds: Set<string>;
  wake: Map<string, DraftHint>;
};

export function createWorkProjectionMutation(input: {
  db: Database;
  draftOwnerHints: Pick<ProjectHintPort, "publishDraftHints">;
  pendingCounts: WorkDraftPendingCounts;
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
      wakeDraftIds: new Set(),
      wake: new Map(),
    }),
    fork: (parent) => ({
      touchedWorkIds: new Set(parent.touchedWorkIds),
      reconcileWorkIds: new Set(parent.reconcileWorkIds),
      reconcileRootIds: new Set(parent.reconcileRootIds),
      recountWorkIds: new Set(parent.recountWorkIds),
      recountRootIds: new Set(parent.recountRootIds),
      wakeDraftIds: new Set(parent.wakeDraftIds),
      wake: new Map(parent.wake),
    }),
    merge(parent, child) {
      for (const workId of child.touchedWorkIds) parent.touchedWorkIds.add(workId);
      for (const workId of child.reconcileWorkIds) parent.reconcileWorkIds.add(workId);
      for (const root of child.reconcileRootIds) parent.reconcileRootIds.add(root);
      for (const workId of child.recountWorkIds) parent.recountWorkIds.add(workId);
      for (const root of child.recountRootIds) parent.recountRootIds.add(root);
      for (const id of child.wakeDraftIds) parent.wakeDraftIds.add(id);
      for (const [owner, hint] of child.wake) parent.wake.set(owner, hint);
      return parent;
    },
    async beforeCommit(state) {
      const unlocked = [...state.recountWorkIds].filter((id) => !state.reconcileWorkIds.has(id));
      const unlockedRoots = [...state.recountRootIds].filter(
        (root) => !state.reconcileRootIds.has(root),
      );
      await resolveWakes(state);
      if (unlocked.length || unlockedRoots.length) {
        const wake = new Map(state.wake);
        state.wake.clear();
        runAfterDrizzleCommit(() => recountInRoot(unlocked.sort(), unlockedRoots.sort(), wake));
      }
      await reconcilePendingCounts(state);
    },
  };

  async function resolveWakes(state: WorksNoticeState): Promise<void> {
    const draftIds = [...state.wakeDraftIds];
    state.wakeDraftIds.clear();
    if (draftIds.length === 0) return;
    const rows = await currentDrizzleDb(input.db)
      .select({ id: drafts.id, projectId: drafts.projectId })
      .from(drafts)
      .where(inArray(drafts.id, draftIds));
    for (const row of rows) state.wake.set(row.id, draftHint(row.projectId, row.id));
  }

  async function recountInRoot(
    workIds: WorkId[],
    lineages: string[],
    wake: ReadonlyMap<string, DraftHint>,
  ): Promise<void> {
    try {
      await runInRootDrizzleTransaction(input.db, () => {
        const state = worksNoticeState();
        for (const [owner, hint] of wake) state.wake.set(owner, hint);
        return mutation.mutate({ works: workIds, lineages }, async () => undefined);
      });
    } catch (error) {
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

  async function reconcilePendingCounts(state: WorksNoticeState): Promise<void> {
    const woken = new Map(state.wake);
    state.wake.clear();
    if (state.reconcileWorkIds.size === 0 && state.reconcileRootIds.size === 0) {
      input.draftOwnerHints.publishDraftHints([...woken.values()]);
      return;
    }
    const workIds = [...state.reconcileWorkIds].sort() as WorkId[];
    const rootThreadIds = [...state.reconcileRootIds].sort();
    state.reconcileWorkIds.clear();
    state.reconcileRootIds.clear();
    const tx = currentDrizzleDb(input.db);
    const draftCounts = await input.pendingCounts.countPendingByOwners({ workIds, rootThreadIds });
    const hints = woken;
    const wake = (projectId: string, draft: string) =>
      hints.set(draft, draftHint(projectId, draft));
    const perKey = (column: AnyColumn, keys: readonly string[], value: (key: string) => number) =>
      sql`(case ${column} ${sql.join(
        keys.map((key) =>
          column === works.id
            ? sql`when ${key}::uuid then ${value(key)}::integer`
            : sql`when ${key} then ${value(key)}::integer`,
        ),
        sql` `,
      )} end)`;
    if (draftCounts.length) {
      const byDraft = new Map(draftCounts.map((row) => [row.draftId, row]));
      const ids = [...byDraft.keys()];
      const documents = perKey(drafts.id, ids, (id) => byDraft.get(id)?.documents ?? 0);
      const folders = perKey(drafts.id, ids, (id) => byDraft.get(id)?.folders ?? 0);
      const movedDrafts = new Set(
        (
          await tx
            .update(drafts)
            .set({ pendingDocumentCount: documents, pendingFolderCount: folders })
            .where(
              and(
                inArray(drafts.id, ids),
                or(
                  ne(drafts.pendingDocumentCount, documents),
                  ne(drafts.pendingFolderCount, folders),
                ),
              ),
            )
            .returning({ id: drafts.id })
        ).map(({ id }) => id as string),
      );
      for (const row of draftCounts)
        if (movedDrafts.has(row.draftId)) wake(row.projectId, row.draftId);
    }
    if (workIds.length > 0) {
      const totals = new Map<string, { documents: number; folders: number }>();
      for (const row of draftCounts)
        if (row.workId) {
          const total = totals.get(row.workId) ?? { documents: 0, folders: 0 };
          totals.set(row.workId, {
            documents: total.documents + row.documents,
            folders: total.folders + row.folders,
          });
        }
      const documents = perKey(works.id, workIds, (id) => totals.get(id)?.documents ?? 0);
      const folders = perKey(works.id, workIds, (id) => totals.get(id)?.folders ?? 0);
      const movedWorks = await tx
        .update(works)
        .set({
          pendingDocumentCount: documents,
          pendingFolderCount: folders,
          entityRevision: sql`${works.entityRevision} + 1`,
        })
        .where(
          and(
            inArray(works.id, workIds),
            or(ne(works.pendingDocumentCount, documents), ne(works.pendingFolderCount, folders)),
          ),
        )
        .returning({ projectId: works.projectId, draftId: workDefaultDraftSql() });
      for (const work of movedWorks) if (work.draftId) wake(work.projectId, work.draftId);
    }
    input.draftOwnerHints.publishDraftHints([...hints.values()]);
  }

  async function resolveOwners(set: WorkWriteSet) {
    const draftIds = [...new Set(set.drafts ?? [])];
    const named = draftOwnerSql();
    const owned =
      draftIds.length === 0
        ? []
        : await currentDrizzleDb(input.db)
            .select({ workId: named.workId, rootThreadId: named.rootThreadId })
            .from(drafts)
            .where(inArray(drafts.id, draftIds));
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
    return { workIds, rootIds };
  }

  async function lockWriteSet(
    set: WorkWriteSet,
    options: WorkWriteOptions = {},
  ): Promise<LockedWorkWriteSet> {
    if (!isInDrizzleTransaction()) {
      throw new Error("Work locks are held by the caller's transaction; none is open");
    }
    const { workIds, rootIds } = await resolveOwners(set);
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
        if (locked.lineages.get(root) !== "active") {
          throw new LineageDraftsUnavailableError(root);
        }
      }
    }
    const state = worksNoticeState();
    for (const workId of workIds) state.reconcileWorkIds.add(workId);
    for (const root of rootIds) state.reconcileRootIds.add(root);
    return locked;
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
    async ownersOf(set) {
      const { workIds, rootIds } = await resolveOwners(set);
      return { workIds, lineageRootIds: rootIds };
    },
    recountAfterCommit({ workIds, lineageRootIds }) {
      if (!workIds.length && !lineageRootIds.length) return;
      const state = worksNoticeState();
      for (const workId of workIds) state.recountWorkIds.add(workId as WorkId);
      for (const root of lineageRootIds) state.recountRootIds.add(root);
    },
    liveChangedUnder(draftIds) {
      const state = worksNoticeState();
      for (const draftId of draftIds) state.wakeDraftIds.add(draftId);
    },
    lifecycleChanged(work) {
      if (work.draftId)
        input.draftOwnerHints.publishDraftHints([draftHint(work.projectId, work.draftId)]);
    },
    mutate(set, operation, options) {
      return runInDrizzleTransaction(input.db, async () =>
        operation(await lockWriteSet(set, options)),
      );
    },
  };
  return mutation;
}

function draftHint(projectId: string, draft: string): DraftHint {
  return { type: "draft-hint", projectId, draft };
}
