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
import { nextEditSeq } from "../../../shared/edit-history-seq.js";
import { readLiveTreeStates } from "../../context/tree/live-tree-state.js";
import { loadDocumentIdentityRows } from "../../context/tree/tree-view-sql.js";
import type { AgentTreeHistory } from "../contracts.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";

type DirectTreeChange = Extract<
  Parameters<AgentTreeHistory["recordAgentTreeChange"]>[0],
  { threadId: unknown }
>;

function directProvenance(input: DirectTreeChange) {
  return {
    threadId: input.threadId,
    turnId: input.turnId ?? null,
    responseId: input.responseIdentity?.providerResponseId ?? null,
    editScopeId: input.responseIdentity?.editScopeId ?? null,
    toolCallId: input.toolCallId ?? null,
    shownAt: input.shownAt,
  };
}

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
      const materialized = input.materializes
        ? await tx()
            .select({
              documentId: documentEdits.documentId,
              actor: documentEdits.actor,
              threadId: documentEdits.threadId,
              turnId: documentEdits.turnId,
              responseId: documentEdits.responseId,
              editScopeId: documentEdits.editScopeId,
              toolCallId: documentEdits.toolCallId,
              tree: documentEdits.treeChange,
            })
            .from(documentEdits)
            .where(eq(documentEdits.id, input.materializes))
            .limit(1)
        : [];
      const source = materialized[0];
      if (
        input.materializes &&
        (!source ||
          source.documentId !== input.documentId ||
          source.actor !== "agent" ||
          !source.threadId ||
          !source.tree ||
          source.tree.op !== "delete" ||
          source.tree.destination.kind !== "draft")
      )
        throw new Error("Applied delete must materialize its exact drafted agent entry");
      const provenance = source
        ? {
            threadId: source.threadId as import("@meridian/contracts").ThreadId,
            turnId: source.turnId,
            responseId: source.responseId,
            editScopeId: source.editScopeId,
            toolCallId: source.toolCallId,
            shownAt: source.tree?.shownAt ?? null,
          }
        : directProvenance(input as DirectTreeChange);
      const transition: TreeTransition =
        change.destination === "draft"
          ? {
              destination: { kind: "draft", branchId: change.branchId },
              before: change.before,
              after: change.after,
            }
          : { destination: { kind: "live" }, before: change.before, after: await liveAfter(input) };
      const wId = await journal.reserveWriteOrdinal(input.documentId, provenance.threadId);
      await recordDocumentEdit(tx(), {
        documentId: input.documentId,
        actor: "agent",
        wId,
        threadId: provenance.threadId,
        turnId: provenance.turnId,
        responseId: provenance.responseId,
        editScopeId: provenance.editScopeId,
        toolCallId: provenance.toolCallId,
        kind: "write",
        receipts: [],
        treeChange: {
          op: input.op,
          ...transition,
          shownAt: provenance.shownAt,
          ...(input.landedAt ? { landedAt: input.landedAt } : {}),
          ...(input.materializes ? { materializes: input.materializes } : {}),
          seq: await nextEditSeq(tx()),
          targets: [],
        },
      });
      return { handle: editHandle(wId) };
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
      const away = rows.filter(
        (row) => row.shownAt && matchDocumentPath([row.shownAt], path, (at) => at),
      );
      // A document still deleted wins over one only moved away: restoring it can allocate a free
      // leaf name, while undoing the newer move first would target a different history entry.
      const identities = await loadDocumentIdentityRows(tx(), [
        ...new Set(away.map((row) => row.documentId as DocumentId)),
      ]);
      const deleted = new Set(identities.filter((row) => row.deleted).map((row) => row.id));
      return (
        (away.find((row) => deleted.has(row.documentId as DocumentId)) ?? away[0])?.documentId ??
        null
      );
    },
  };
}
