/**
 * The application mutation boundary for Works: the one owner of Work-first lock order for
 * every lifecycle or structural write that holds a Work's draft row, draft-tree row or document row, which
 * is how those writes order themselves against the Work's lifecycle transitions, and the
 * canonical transaction participant for every mutation visible in a Works snapshot. It owns
 * the Work's stored pending count (the badge): every Work a transaction locks through it is
 * recounted at commit, and a moved count bumps the Work's revision and sends a notice. A live
 * change under a draft's rows (`liveChangedUnder`) only wakes the owner: the list reads live
 * where it has rows. Every owner a commit wakes gets one hint, in one publish. A keystroke never
 * enters it: the document's derivation recounts the Work's suggestions after it, through
 * `mutate`.
 */
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
} from "../../../shared/work-lifecycle-lock.js";
import type { ProjectHintPort } from "../../context/ports/project-hints.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { WorkLifecycleUnavailableError } from "../domain/work-lifecycle.js";
import type { WorkDraftPendingCounts } from "../ports/work-draft-pending-counts.js";

/**
 * The owners a write names: directly, or through the drafts it changes. A lineage is named by
 * its root thread id.
 */
export type WorkWriteSet = {
  works?: readonly WorkId[];
  lineages?: readonly string[];
  drafts?: readonly DraftId[];
};

export type WorkWriteOptions = {
  /** With the bound edit grants' Works, then the grants' confirmation (file-access §5). */
  seam?: boolean;
  /** Refuses unless every Work and lineage of the set is active. */
  requireActive?: boolean;
};

export type LockedWorkWriteSet = {
  /** Every locked Work's lifecycle, read under its lock. */
  works: ReadonlyMap<string, LockedWork>;
  /** Every locked lineage's liveness, read under its lock. */
  lineages: ReadonlyMap<string, "active" | "frozen">;
};

export type WorkProjectionMutation = {
  /** Activity on the Works (`lastActivityAt`): a revision and a notice, count or not. */
  touchWorks(workIds: readonly WorkId[], activityAt: Date): Promise<void>;
  /**
   * Owner-first order: the set's Works locked `FOR NO KEY UPDATE` in id order, then its
   * lineages' draft-owner locks in root order, in the caller's transaction, before it takes any
   * draft row, draft-tree row or document row. At commit each locked owner's drafts are recounted and
   * stored; a Work whose total moved gets a revision, and it and every draft whose count moved
   * wake their owner with a `draft-hint`; unmoved counts get neither. Apart from the owners'
   * own lifecycle writers, nothing else in collab or projects locks an owner for a write.
   */
  lockWorks(set: WorkWriteSet, options?: WorkWriteOptions): Promise<LockedWorkWriteSet>;
  /**
   * The Works and lineages `lockWorks` would lock for the set, read with no lock: what a caller
   * that must hold them earlier (in the order of another lock family) declares.
   */
  ownersOf(set: WorkWriteSet): Promise<OwnerLocks>;
  /**
   * `lockWorks`, then `operation` (given what the locks read), in one transaction (its own when
   * the caller has none).
   */
  mutate<T>(
    set: WorkWriteSet,
    operation: (locked: LockedWorkWriteSet) => Promise<T>,
    options?: WorkWriteOptions,
  ): Promise<T>;
  /**
   * Works whose pending count the caller's transaction changed without holding them (it is
   * past Work-first order): each is recounted in a root transaction of its own once the caller
   * commits, unless the caller already locked it through this boundary.
   */
  recountAfterCommit(owners: OwnerLocks): void;
  /**
   * The Work was archived, unarchived, deleted, restored or purged: once the caller commits, the
   * Work's `draft-hint` goes out, as for a count that moved, so the Works list and the
   * Work's drafts list are read again.
   */
  lifecycleChanged(work: { id: WorkId; projectId: string; draftId: string | null }): void;
  /**
   * A tree commit changed live rows that these drafts have rows on, their rows' parents, or a
   * document their Work has suggestions in: once it commits, each
   * draft's owner gets its `draft-hint`, since its list reads live there (a move's
   * place) and neither its count nor its membership need have moved. No lock, no revision.
   */
  liveChangedUnder(draftIds: readonly string[]): void;
};

const WORKS_NOTICE_STATE = {};
type WorksNoticeState = {
  touchedWorkIds: Set<WorkId>;
  /** Works locked through the boundary: their pending count is reconciled once, at commit. */
  reconcileWorkIds: Set<WorkId>;
  /** Lineages locked through the boundary: their drafts' counts are reconciled at commit. */
  reconcileRootIds: Set<string>;
  /** Owners changed but not locked: recounted after commit unless locked by then. */
  recountWorkIds: Set<WorkId>;
  recountRootIds: Set<string>;
  /** Owners woken whatever their count did, by a live change under their draft's rows. */
  wakeDraftIds: Set<string>;
  /** Their hints, resolved at commit and sent with the commit's one publish. */
  wake: Map<string, DraftHint>;
};

export function createWorkProjectionMutation(input: {
  db: Database;
  draftOwnerHints: Pick<ProjectHintPort, "publishDraftHints">;
  /** The collab-owned pending membership rule, counted per Work in SQL. */
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
        // The recount publishes once for its owners: these wakes go out with it.
        const wake = new Map(state.wake);
        state.wake.clear();
        runAfterDrizzleCommit(() => recountInRoot(unlocked.sort(), unlockedRoots.sort(), wake));
      }
      await reconcilePendingCounts(state);
    },
  };

  /** The drafts marked to wake, as hints on the state. */
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
   * once per transaction, however many writes it made, and writes only a count that moved. A
   * text write that commits after the count is not lost: the document's derivation runs after it
   * and its `mutate` reconciles again; the stored value, not a count taken before this
   * transaction's own writes, is what that compares against.
   */
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
    // Each owner whose list gained or lost a document is woken once: a draft whose count moved,
    // and a Work whose total moved (a whole Discard closes the draft, which then counts nowhere).
    const hints = woken;
    const wake = (projectId: string, draft: string) =>
      hints.set(draft, draftHint(projectId, draft));
    // One CASE per column: each draft's or Work's documents and folders changed, stored side by
    // side so a surface can name each (a Work moves when either does).
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
      // A Work's totals are its draft's.
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

  /** The owners a set names. */
  async function resolveOwners(set: WorkWriteSet) {
    const draftIds = [...new Set(set.drafts ?? [])];
    // A draft's owner is whoever names it: its Work, or its lineage's root chat.
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
    // Whatever the caller changes under these locks, the counts follow at commit.
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
    /**
     * The set's Works locked before `operation` takes any draft or draft-tree row, so every
     * structural draft write enters Work, then draft row, then draft-tree rows, the order Archive takes.
     */
    mutate(set, operation, options) {
      return runInDrizzleTransaction(input.db, async () =>
        operation(await lockWriteSet(set, options)),
      );
    },
  };
  return mutation;
}

/** A draft's list is stale; the Work naming it shows its count, so its Works row is too. */
function draftHint(projectId: string, draft: string): DraftHint {
  return { type: "draft-hint", projectId, draft };
}
