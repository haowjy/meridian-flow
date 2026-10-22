/**
 * The model's moves and deletes in a document's edit history, live or drafted: the row its call
 * records in the tree mutation's own transaction (a handle on the per-document, per-chat counter, D76), the
 * Works whose drafts outlive a delete (D79), and the document a chat's own tree entry moved or
 * deleted away from a path, so `undo`, `redo` and `revert` can still name it there.
 */
import { editHandle, type UpdateJournal } from "@meridian/agent-edit/integration";
import { type DocumentId, matchDocumentPath, type TreeTransition } from "@meridian/contracts";
import { type Database, documentEdits } from "@meridian/database";
import { branches, documentDrafts, works } from "@meridian/database/schema";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { readLiveTreeStates } from "../../context/tree/live-tree-state.js";
import type { AgentTreeHistory } from "../contracts.js";
import { nextEditSeq, recordDocumentEdit } from "./drizzle-document-edits.js";

export function createDrizzleTreeHistory(
  db: Database,
  journal: Pick<UpdateJournal, "reserveWriteOrdinal">,
): AgentTreeHistory {
  const tx = () => currentDrizzleDb(db);
  async function liveAfter(input: { documentId: DocumentId; op: string }) {
    const after = (await readLiveTreeStates(tx(), [input.documentId])).get(input.documentId);
    if (!after) throw new Error(`A ${input.op} left ${input.documentId} hidden`);
    return after;
  }
  return {
    async liveState(documentId) {
      return (await readLiveTreeStates(tx(), [documentId])).get(documentId) ?? null;
    },

    async recordAgentTreeChange(input) {
      const { change } = input;
      const transition: TreeTransition =
        change.destination === "draft"
          ? {
              destination: { kind: "draft", branchId: change.branchId },
              before: change.before,
              after: change.after,
            }
          : { destination: { kind: "live" }, before: change.before, after: await liveAfter(input) };
      const wId = await journal.reserveWriteOrdinal(input.documentId, input.threadId);
      await recordDocumentEdit(tx(), {
        documentId: input.documentId,
        actor: "agent",
        wId,
        threadId: input.threadId,
        turnId: input.turnId ?? null,
        responseId: input.responseIdentity?.providerResponseId ?? null,
        editScopeId: input.responseIdentity?.editScopeId ?? null,
        kind: "write",
        receipts: [],
        treeChange: {
          op: input.op,
          ...transition,
          shownAt: input.shownAt,
          ...(input.landedAt ? { landedAt: input.landedAt } : {}),
          seq: await nextEditSeq(tx()),
          targets: [],
        },
      });
      return { handle: editHandle(wId) };
    },

    async survivingDraftWorks(documentId) {
      const rows = await tx()
        .selectDistinct({ handle: works.handle })
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
            isNotNull(works.handle),
          ),
        );
      return rows.flatMap((row) => (row.handle ? [row.handle] : [])).sort();
    },

    async movedAwayFrom(threadId, path) {
      const rows = await tx()
        .select({
          documentId: documentEdits.documentId,
          shownAt: sql<string | null>`${documentEdits.treeChange}->>'shownAt'`,
        })
        .from(documentEdits)
        .where(
          and(
            eq(documentEdits.threadId, threadId),
            eq(documentEdits.actor, "agent"),
            inArray(sql`${documentEdits.treeChange}->>'op'`, ["move", "delete"]),
          ),
        )
        .orderBy(desc(sql`(${documentEdits.treeChange}->>'seq')::bigint`));
      for (const row of rows)
        if (row.shownAt && matchDocumentPath([row.shownAt], path, (at) => at))
          return row.documentId;
      return null;
    },
  };
}
