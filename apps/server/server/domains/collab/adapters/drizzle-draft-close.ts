/**
 * What a transaction ends for the rooms: the drafts it deletes (a Work's purge, a document's
 * purge) and the documents it removes. A draft never closes: its row is open until a purge
 * deletes it, so the only ending is the room's, retired once the root transaction commits. A
 * draft whose document the same transaction removed retires as a removal.
 */

import type { BranchId, DocumentId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { documentDrafts } from "@meridian/database/schema";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import {
  type DrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  runAfterDrizzleCommit,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type {
  DraftRetirement,
  DraftRetirementBatch,
  EndedDraft,
} from "../domain/draft-retirement.js";

/** Which drafts a close takes: by document (optionally one branch's), branch or id. */
export type DraftSelection =
  | { documentIds: readonly DocumentId[]; branchId?: BranchId }
  | { branchId: BranchId }
  | { draftIds: readonly string[] };

export function draftSelectionPredicate(selection: DraftSelection): SQL | undefined {
  if ("documentIds" in selection)
    return and(
      inArray(documentDrafts.documentId, [...selection.documentIds]),
      selection.branchId ? eq(documentDrafts.branchId, selection.branchId) : undefined,
    );
  if ("draftIds" in selection) return inArray(documentDrafts.id, [...selection.draftIds]);
  return eq(documentDrafts.branchId, selection.branchId);
}

/** The caller holds its Work/branch and document admission locks. */
export async function lockDrafts(db: DrizzleDb, selection: DraftSelection) {
  return db
    .select({ id: documentDrafts.id })
    .from(documentDrafts)
    .where(draftSelectionPredicate(selection))
    .orderBy(asc(documentDrafts.id))
    .for("update");
}

type Batch = { ended: EndedDraft[]; removed: Map<DocumentId, DocumentRemovalRecord> };

export type DraftClose = {
  /**
   * Adds removed documents to the root transaction's retirement batch: their live rooms close
   * `4208` after commit. Their drafts stay as they are.
   */
  registerRemoved(documentIds: readonly DocumentId[], record: DocumentRemovalRecord): void;
  /**
   * Names the selection's drafts, which the caller deletes in this transaction, so their rooms
   * retire after it commits. Writes nothing.
   */
  endDrafts(db: DrizzleDb, selection: DraftSelection): Promise<void>;
  /** The composition's retirement, bound once its rooms and cores exist; unbound retires nothing. */
  bindRetirement(retire: DraftRetirement, onError: (error: unknown) => void): void;
};

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
    create: () => ({ ended: [], removed: new Map() }),
    fork: () => ({ ended: [], removed: new Map() }),
    merge(parent, child) {
      parent.ended.push(...child.ended);
      for (const [id, record] of child.removed) parent.removed.set(id, record);
      return parent;
    },
    async beforeCommit(batch) {
      if (!batch.ended.length && !batch.removed.size) return;
      runAfterDrizzleCommit(() => retire(batch));
    },
  };

  return {
    registerRemoved(documentIds, record) {
      const batch = enlistDrizzleTransactionParticipant(participant);
      for (const id of documentIds) batch.removed.set(id, record);
    },
    async endDrafts(db, selection) {
      const batch = enlistDrizzleTransactionParticipant(participant);
      const rows = await db
        .select({ draftId: documentDrafts.id, documentId: documentDrafts.documentId })
        .from(documentDrafts)
        .where(draftSelectionPredicate(selection));
      batch.ended.push(
        ...rows.map((row) => ({ ...row, documentId: row.documentId as DocumentId })),
      );
    },
    bindRetirement(retire, onError) {
      sink = { retire, onError };
    },
  };
}
