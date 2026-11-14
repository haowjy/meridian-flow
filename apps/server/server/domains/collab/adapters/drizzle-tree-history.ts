/**
 * The model's tree changes as receipts: the row its call keeps in the tool call's own transaction
 * (a handle on the node's per-chat counter, which `undo`, `redo` and `revert` name), and the
 * Works whose drafts outlive a delete.
 */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { editHandle } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts";
import { type Database, documentEdits, treeEditReceipts } from "@meridian/database";
import { branches, documentDrafts, works } from "@meridian/database/schema";
import { and, desc, eq, isNotNull, max, type SQL } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { AgentTreeHistory } from "../contracts.js";

export function createDrizzleTreeHistory(
  db: Database,
  journal: Pick<UpdateJournal, "reserveWriteOrdinal">,
): AgentTreeHistory {
  const tx = () => currentDrizzleDb(db);
  const receiptsWhere = async (where: SQL | undefined) => {
    const rows = await tx()
      .select()
      .from(treeEditReceipts)
      .where(where)
      .orderBy(desc(treeEditReceipts.seq));
    return rows.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      records: row.records,
      op: row.op,
      kind: row.kind,
      reverses: row.reverses,
      wId: row.wId,
      draftBranchId: row.draftBranchId,
      createdAt: row.createdAt,
    }));
  };
  return {
    async recordAgentTreeChange(input) {
      // A node's counter is the document's own for a document, so a handle names one edit of
      // either kind; a folder has no document, and the counter takes any node id.
      const wId = await journal.reserveWriteOrdinal(
        input.nodeId as Parameters<typeof journal.reserveWriteOrdinal>[0],
        input.threadId,
      );
      const [row] = await tx()
        .insert(treeEditReceipts)
        .values({
          threadId: input.threadId,
          turnId: input.turnId ?? null,
          responseId: input.responseIdentity?.providerResponseId ?? null,
          editScopeId: input.responseIdentity?.editScopeId ?? null,
          toolCallId: input.toolCallId ?? null,
          nodeId: input.nodeId,
          records: input.records,
          op: input.op,
          kind: input.reverses?.kind ?? "write",
          reverses: input.reverses?.receipt ?? null,
          wId,
          draftBranchId: input.draftBranchId ?? null,
          shownAt: input.shownAt,
          landedAt: input.landedAt ?? null,
        })
        .returning({ id: treeEditReceipts.id });
      if (!row) throw new Error("A tree receipt was not inserted");
      return { handle: editHandle(wId), id: row.id };
    },

    async draftedInReply(turnId) {
      const [row] = await tx()
        .select({ id: treeEditReceipts.id })
        .from(treeEditReceipts)
        .where(and(eq(treeEditReceipts.turnId, turnId), isNotNull(treeEditReceipts.draftBranchId)))
        .limit(1);
      return row !== undefined;
    },

    receiptsFor: (threadId, nodeId) =>
      receiptsWhere(
        and(eq(treeEditReceipts.threadId, threadId), eq(treeEditReceipts.nodeId, nodeId)),
      ),

    receiptsAt: (threadId, shownAt) =>
      receiptsWhere(
        and(eq(treeEditReceipts.threadId, threadId), eq(treeEditReceipts.shownAt, shownAt)),
      ),

    async latestTextEditAt(threadId, documentId) {
      const [row] = await tx()
        .select({ at: max(documentEdits.createdAt) })
        .from(documentEdits)
        .where(
          and(
            eq(documentEdits.threadId, threadId),
            eq(documentEdits.documentId, documentId as DocumentId),
          ),
        );
      return row?.at ?? null;
    },

    async survivingDraftWorks(documentId) {
      const rows = await tx()
        .selectDistinct({ name: works.name })
        .from(documentDrafts)
        .innerJoin(branches, eq(branches.id, documentDrafts.branchId))
        .innerJoin(works, eq(works.id, branches.originWorkId))
        .where(
          and(
            eq(documentDrafts.documentId, documentId),
            eq(documentDrafts.kind, "work_draft"),
            eq(documentDrafts.status, "active"),
            eq(documentDrafts.hasEffect, true),
            eq(branches.status, "active"),
            // No Work's drafts are a chat's own, not a Work's.
            isNotNull(works.handle),
          ),
        );
      // By name, as the model repeats it to the writer, who never sees handles (#914).
      return rows.map((row) => `Work "${row.name}"`).sort();
    },
  };
}
