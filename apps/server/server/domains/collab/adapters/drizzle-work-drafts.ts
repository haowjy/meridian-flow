/**
 * A Work's drafts (design §2, "The draft row stays, and a Work has several"): the list the version
 * chip shows, `+ New draft`, rename, `Delete draft` and its Undo, which draft a chat writes into,
 * and the purge of a draft deleted 30 days ago. Lock order: the Work's row first (the owner slot),
 * then the draft rows; the purge then takes the draft's tree lists, then its forks' documents.
 */
import type { DraftId, ThreadId, WorkId } from "@meridian/contracts";
import { newDraftId } from "@meridian/contracts";
import type { WorkDraft } from "@meridian/contracts/drafts";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import { documentForks, drafts, threads, threadWorks, works } from "@meridian/database/schema";
import { newId } from "@meridian/project-tree";
import { and, asc, desc, eq, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { treeListsOfDraft } from "./drizzle-draft-tree-lists.js";
import { discardTreeRecords } from "./drizzle-work-tree-discard.js";

const DRAFT_PURGE_BATCH = 100;

export type WorkDrafts = {
  list(workId: WorkId): Promise<WorkDraft[]>;
  /** A draft of the Work; null when the Work is gone. An id the Work already has answers that draft. */
  create(input: {
    workId: WorkId;
    draftId?: DraftId;
    name?: string | null;
    userId: string;
  }): Promise<WorkDraft | null>;
  rename(input: {
    workId: WorkId;
    draftId: DraftId;
    name: string | null;
  }): Promise<WorkDraft | null>;
  /**
   * `Delete draft`: the draft is kept and listed nowhere; root chats naming it name the Work's
   * default, and a deleted default passes on to the Work's oldest other draft, or a new one.
   */
  remove(input: { workId: WorkId; draftId: DraftId; userId: string }): Promise<void>;
  /** Its Undo: listed again, as one of the Work's drafts (its chats stay where the delete put them). */
  restore(input: { workId: WorkId; draftId: DraftId }): Promise<WorkDraft | null>;
  /**
   * The draft a chat's lineage writes into: its root names `draftId` when that is one of the
   * root's Work's living drafts; anything else changes nothing. Answers the chat's draft.
   */
  setChatDraft(input: { threadId: ThreadId; draftId: DraftId }): Promise<DraftId | null>;
  /** Drafts deleted before the retention cutoff, purged with their forks; how many. */
  purgeDeleted(now?: Date): Promise<number>;
};

export function createDrizzleWorkDrafts(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate" | "recountAfterCommit">;
    treeLists: Pick<TreeListStore, "lock" | "submit" | "resync">;
    /** Ends a purged draft's loaded fork rooms without saving. */
    endRooms(rooms: readonly DocumentRoom[]): Promise<void>;
  },
): WorkDrafts {
  const tx = () => currentDrizzleDb(db);
  const columns = {
    id: drafts.id,
    workId: drafts.workId,
    name: drafts.name,
    isDefault: drafts.isDefault,
    pendingDocumentCount: drafts.pendingDocumentCount,
    pendingFolderCount: drafts.pendingFolderCount,
    createdAt: drafts.createdAt,
  };
  type Row = Omit<WorkDraft, "workId" | "createdAt"> & { workId: string | null; createdAt: Date };
  const answer = (row: Row): WorkDraft => ({
    ...row,
    workId: row.workId as WorkId,
    createdAt: row.createdAt.toISOString(),
  });

  async function living(workId: WorkId, draftId: DraftId) {
    const [row] = await tx()
      .select(columns)
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.workId, workId), isNull(drafts.deletedAt)));
    return row ? answer(row) : null;
  }

  /** The Work's row locked, as every draft command's first lock; null for a Work that is gone. */
  const withWork = <T>(workId: WorkId, run: () => Promise<T>) =>
    deps.workProjection.mutate({ works: [workId] }, run, { requireActive: false });

  return {
    async list(workId) {
      const rows = await tx()
        .select(columns)
        .from(drafts)
        .where(and(eq(drafts.workId, workId), isNull(drafts.deletedAt)))
        .orderBy(desc(drafts.isDefault), asc(drafts.createdAt), asc(drafts.id));
      return rows.map(answer);
    },

    create: ({ workId, draftId, name, userId }) =>
      withWork(workId, async () => {
        const [work] = await tx()
          .select({ projectId: works.projectId, isNoWork: works.isNoWork })
          .from(works)
          .where(eq(works.id, workId));
        if (!work || work.isNoWork) return null;
        const id = draftId ?? newDraftId();
        await tx()
          .insert(drafts)
          .values({
            id,
            projectId: work.projectId,
            workId,
            name: name ?? null,
            createdBy: userId as never,
          })
          .onConflictDoNothing();
        return living(workId, id);
      }),

    rename: ({ workId, draftId, name }) =>
      withWork(workId, async () => {
        await tx()
          .update(drafts)
          .set({ name })
          .where(and(eq(drafts.id, draftId), eq(drafts.workId, workId)));
        return living(workId, draftId);
      }),

    remove: ({ workId, draftId, userId }) =>
      withWork(workId, async () => {
        const [gone] = await tx()
          .update(drafts)
          .set({ deletedAt: sql`now()`, isDefault: false })
          .where(and(eq(drafts.id, draftId), eq(drafts.workId, workId), isNull(drafts.deletedAt)))
          .returning({ projectId: drafts.projectId });
        if (!gone) return;
        // A deleted default leaves the Work none: the oldest other draft, or a new one, takes it.
        const [kept] = await tx()
          .select({ id: drafts.id })
          .from(drafts)
          .where(and(eq(drafts.workId, workId), eq(drafts.isDefault, true)));
        let fallback = kept?.id ?? null;
        if (!fallback) {
          const [oldest] = await tx()
            .select({ id: drafts.id })
            .from(drafts)
            .where(and(eq(drafts.workId, workId), isNull(drafts.deletedAt)))
            .orderBy(asc(drafts.createdAt), asc(drafts.id))
            .limit(1);
          fallback = oldest?.id ?? newDraftId();
          if (oldest)
            await tx().update(drafts).set({ isDefault: true }).where(eq(drafts.id, oldest.id));
          else
            await tx()
              .insert(drafts)
              .values({
                id: fallback,
                projectId: gone.projectId,
                workId,
                isDefault: true,
                createdBy: userId as never,
              });
        }
        await tx().update(threads).set({ draftId: fallback }).where(eq(threads.draftId, draftId));
        deps.workProjection.recountAfterCommit({ workIds: [workId], lineageRootIds: [] });
      }),

    restore: ({ workId, draftId }) =>
      withWork(workId, async () => {
        await tx()
          .update(drafts)
          .set({ deletedAt: null })
          .where(
            and(eq(drafts.id, draftId), eq(drafts.workId, workId), isNotNull(drafts.deletedAt)),
          );
        deps.workProjection.recountAfterCommit({ workIds: [workId], lineageRootIds: [] });
        return living(workId, draftId);
      }),

    async setChatDraft({ threadId, draftId }) {
      const [chat] = await tx()
        .select({ root: threads.rootThreadId, workId: threadWorks.workId })
        .from(threads)
        .leftJoin(
          threadWorks,
          and(eq(threadWorks.threadId, threads.rootThreadId), eq(threadWorks.isPrimary, true)),
        )
        .where(eq(threads.id, threadId));
      if (!chat) return null;
      const named = async () => {
        const [root] = await tx()
          .select({ draftId: threads.draftId })
          .from(threads)
          .where(eq(threads.id, chat.root));
        return root?.draftId ?? null;
      };
      if (!chat.workId) return named();
      // Under the Work's row, as `remove` takes it: a draft deleted after this read is not named.
      const workId = chat.workId as WorkId;
      const chosen = await withWork(workId, async () => {
        await tx().execute(sql`
          UPDATE threads root SET draft_id = d.id
          FROM thread_works tw, drafts d
          WHERE root.id = ${chat.root}::uuid AND tw.thread_id = root.id AND tw.is_primary
            AND tw.work_id = ${workId}::uuid
            AND d.id = ${draftId} AND d.work_id = tw.work_id AND d.deleted_at IS NULL`);
        return named();
      });
      return chosen;
    },

    async purgeDeleted(now = new Date()) {
      const due = await tx()
        .select({ id: drafts.id, workId: drafts.workId })
        .from(drafts)
        .where(and(isNotNull(drafts.workId), lte(drafts.deletedAt, deletionPurgeCutoff(now))))
        .orderBy(asc(drafts.deletedAt))
        .limit(DRAFT_PURGE_BATCH);
      let purged = 0;
      for (const { id, workId } of due) {
        const forks = await withWork(workId as WorkId, async () => {
          const [locked] = await tx()
            .select({ id: drafts.id })
            .from(drafts)
            .where(and(eq(drafts.id, id), isNotNull(drafts.deletedAt), ne(drafts.isDefault, true)))
            .for("no key update");
          if (!locked) return null;
          const lists = await treeListsOfDraft(db, id);
          if (lists.length > 0) await deps.treeLists.lock(lists);
          await discardTreeRecords(db, deps, { draftId: id, commandId: newId() });
          await deps.treeLists.resync(lists);
          const rooms = await tx()
            .select({ documentId: documentForks.documentId })
            .from(documentForks)
            .where(eq(documentForks.draftId, id))
            .orderBy(asc(documentForks.documentId));
          // A fork's save checks the draft under its document's key: holding the keys, the
          // delete lands before or after each save, never under one.
          for (const { documentId } of rooms) await lockDocumentMutation(tx(), documentId);
          // Its forks, their snapshots (by trigger), its press rows and tree rows go with it.
          await tx().delete(drafts).where(eq(drafts.id, id));
          return rooms.map(
            ({ documentId }): DocumentRoom => ({ kind: "fork", draftId: id, documentId }),
          );
        });
        if (!forks) continue;
        await deps.endRooms(forks);
        purged++;
      }
      return purged;
    },
  };
}
