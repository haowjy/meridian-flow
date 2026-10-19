/**
 * Ending drafts: the one close for every cause, locking upstream Work drafts before thread
 * peers, and the retirement it owes once the root transaction commits.
 *
 * Every close joins its root transaction's retirement batch (a transaction participant, so a
 * rolled-back savepoint's closes leave with it); a removal adds its documents and record. The
 * batch retires once, after the root commits: a draft whose document the same transaction
 * removed retires as a removal whatever its own cause, so a Discard that closes a created
 * document's drafts and then tombstones it closes their rooms `4208`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { BranchId, DocumentId, ThreadId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { documentDrafts } from "@meridian/database/schema";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import {
  type DrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  runAfterDrizzleCommit,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type {
  ClosedDraft,
  DraftCloseCause,
  DraftRetirement,
  DraftRetirementBatch,
} from "../domain/draft-retirement.js";

/** Which drafts a close takes: by document (optionally one branch's), branch, id or upstream. */
export type DraftSelection =
  | { documentIds: readonly DocumentId[]; branchId?: BranchId }
  | { branchId: BranchId }
  | { draftIds: readonly string[] }
  | { upstreamDraftIds: readonly string[] };

export function draftSelectionPredicate(selection: DraftSelection): SQL | undefined {
  if ("documentIds" in selection)
    return and(
      inArray(documentDrafts.documentId, [...selection.documentIds]),
      selection.branchId ? eq(documentDrafts.branchId, selection.branchId) : undefined,
    );
  if ("draftIds" in selection) return inArray(documentDrafts.id, [...selection.draftIds]);
  if ("upstreamDraftIds" in selection)
    return inArray(documentDrafts.upstreamDraftId, [...selection.upstreamDraftIds]);
  return eq(documentDrafts.branchId, selection.branchId);
}

/** The caller holds its Work/branch and document admission locks; pulls lock upstream first too. */
export async function lockActiveDrafts(db: DrizzleDb, selection: DraftSelection) {
  const rows = [];
  for (const kind of ["work_draft", "thread_peer"] as const) {
    rows.push(
      ...(await db
        .select({
          id: documentDrafts.id,
          threadId: documentDrafts.threadId,
        })
        .from(documentDrafts)
        .where(
          and(
            draftSelectionPredicate(selection),
            eq(documentDrafts.status, "active"),
            eq(documentDrafts.kind, kind),
          ),
        )
        .orderBy(asc(documentDrafts.id))
        .for("update")),
    );
  }
  return rows;
}

type Batch = { closed: ClosedDraft[]; removed: Map<DocumentId, DocumentRemovalRecord> };

export type DraftClose = {
  /**
   * Close exactly the selection's active drafts and retire them after the root transaction
   * commits. Already-closed rows keep their cause. A removal's selection names its documents, whose rooms close even with no draft.
   */
  closeDrafts(
    db: DrizzleDb,
    selection: DraftSelection,
    cause: DraftCloseCause,
  ): Promise<readonly (ClosedDraft & { branchId: string })[]>;
  /**
   * Runs `run`, holding back the retirements its commits schedule until it settles. A caller
   * whose commit happens inside process-level live document scopes uses it: retirement, and a
   * save racing it, must never wait on scopes the committing caller still holds.
   */
  holdRetirement<T>(run: () => Promise<T>): Promise<T>;
  /** The composition's retirement, bound once its rooms and cores exist; unbound retires nothing. */
  bindRetirement(retire: DraftRetirement, onError: (error: unknown) => void): void;
};

/** Work started inside a hold may commit after it settled; that work retires at once. */
type Hold = { effects: Array<() => Promise<void>>; open: boolean };
const retirementHold = new AsyncLocalStorage<Hold>();

export function createDraftClose(): DraftClose {
  let sink: { retire: DraftRetirement; onError(error: unknown): void } | null = null;

  async function retire(batch: DraftRetirementBatch): Promise<void> {
    try {
      await testHook("draft.beforeRetirement");
      await sink?.retire(batch);
    } catch (error) {
      sink?.onError(error);
    }
  }

  const participant: DrizzleTransactionParticipant<Batch> = {
    key: {},
    create: () => ({ closed: [], removed: new Map() }),
    fork: () => ({ closed: [], removed: new Map() }),
    merge(parent, child) {
      parent.closed.push(...child.closed);
      for (const [id, record] of child.removed) parent.removed.set(id, record);
      return parent;
    },
    async beforeCommit(batch) {
      if (!batch.closed.length && !batch.removed.size) return;
      runAfterDrizzleCommit(async () => {
        const hold = retirementHold.getStore();
        if (hold?.open) hold.effects.push(() => retire(batch));
        else await retire(batch);
      });
    },
  };

  return {
    async closeDrafts(db, selection, cause) {
      const batch = enlistDrizzleTransactionParticipant(participant);
      if (typeof cause === "object") {
        if (!("documentIds" in selection))
          throw new Error("A removal closes the drafts of the documents it removed");
        for (const id of selection.documentIds) batch.removed.set(id, cause.documentRemoved);
      }
      const rows = await lockActiveDrafts(db, selection);
      const closed = rows.length
        ? await db
            .update(documentDrafts)
            .set({
              status: "closed",
              closedCause: typeof cause === "object" ? "document_removed" : "discarded",
              updatedAt: new Date(),
              revision: sql`${documentDrafts.revision} + 1`,
            })
            .where(
              inArray(
                documentDrafts.id,
                rows.map((row) => row.id),
              ),
            )
            .returning({
              draftId: documentDrafts.id,
              documentId: documentDrafts.documentId,
              threadId: documentDrafts.threadId,
              branchId: documentDrafts.branchId,
            })
        : [];
      const ended = closed.map((row) => ({
        draftId: row.draftId,
        documentId: row.documentId as DocumentId,
        threadId: (row.threadId as ThreadId | null) ?? null,
        branchId: row.branchId,
        cause,
      }));
      batch.closed.push(...ended);
      return ended;
    },
    async holdRetirement(run) {
      const hold: Hold = { effects: [], open: true };
      try {
        return await retirementHold.run(hold, run);
      } finally {
        hold.open = false;
        for (const effect of hold.effects) await effect();
      }
    },
    bindRetirement(retire, onError) {
      sink = { retire, onError };
    },
  };
}
