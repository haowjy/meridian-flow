/**
 * The model's tree changes as receipts: the rows its call keeps in the tool call's own
 * transaction (a write ordinal on each node it changed, from the counter the node's text edits
 * take too), the one history of a node `undo`, `redo` and `revert` choose from, and the Works
 * whose drafts outlive a delete.
 */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { editHandle } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts";
import {
  type Database,
  documentEdits,
  treeEditReceiptNodes,
  treeEditReceipts,
} from "@meridian/database";
import { branches, documentDrafts, works } from "@meridian/database/schema";
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { AgentTreeHistory, NodeHistory, TreeReceipt } from "../contracts.js";
import { boundCommandId } from "./drizzle-document-edits.js";

export function createDrizzleTreeHistory(
  db: Database,
  journal: Pick<UpdateJournal, "reserveWriteOrdinal">,
  /** The text engine's own stack of a document for a chat: ordinals of what Undo and Redo would take. */
  textStack: (
    threadId: string,
    documentId: string,
  ) => Promise<Omit<NodeHistory["text"], "commands">>,
): AgentTreeHistory {
  const tx = () => currentDrizzleDb(db);
  const textCommands = async (threadId: string, documentId: string, ordinals: number[]) => {
    if (ordinals.length === 0) return {};
    const rows = await tx()
      .select({ wId: documentEdits.wId, commandId: documentEdits.commandId })
      .from(documentEdits)
      .where(
        and(
          eq(documentEdits.documentId, documentId as DocumentId),
          eq(documentEdits.threadId, threadId as ThreadId),
          inArray(documentEdits.wId, ordinals),
        ),
      );
    return Object.fromEntries(
      rows.flatMap((row) => (row.wId !== null && row.commandId ? [[row.wId, row.commandId]] : [])),
    );
  };
  return {
    async recordAgentTreeChange(input) {
      const [row] = await tx()
        .insert(treeEditReceipts)
        .values({
          threadId: input.threadId,
          turnId: input.turnId ?? null,
          responseId: input.responseIdentity?.modelResponseId ?? null,
          commandId: boundCommandId(),
          toolCallId: input.toolCallId ?? null,
          nodeId: input.subject,
          records: input.records,
          op: input.op,
          kind: input.reverses?.kind ?? "write",
          reverses: input.reverses?.receipt ?? null,
          draftBranchId: input.draftBranchId ?? null,
          acrossLists: input.acrossLists ?? false,
          shownAt: input.shownAt,
        })
        .returning({ id: treeEditReceipts.id });
      if (!row) throw new Error("A tree receipt was not inserted");
      // A node's counter is the document's own for a document, so one ordinal orders its text
      // edits and tree changes; a folder has no document, and the counter takes any node id.
      const nodes = input.nodes.some((node) => node.nodeId === input.subject)
        ? input.nodes
        : [{ nodeId: input.subject, beforeAt: null, afterAt: null }, ...input.nodes];
      let handle = 0;
      const reserved: (typeof treeEditReceiptNodes.$inferInsert)[] = [];
      for (const node of nodes) {
        const wId = await journal.reserveWriteOrdinal(
          node.nodeId as Parameters<typeof journal.reserveWriteOrdinal>[0],
          input.threadId,
        );
        if (node.nodeId === input.subject) handle = wId;
        reserved.push({
          receiptId: row.id,
          threadId: input.threadId,
          nodeId: node.nodeId,
          wId,
          beforeAt: node.beforeAt,
          afterAt: node.afterAt,
        });
      }
      await tx().insert(treeEditReceiptNodes).values(reserved);
      return { handle: editHandle(handle), id: row.id };
    },

    async draftedInReply(turnId) {
      const [row] = await tx()
        .select({ id: treeEditReceipts.id })
        .from(treeEditReceipts)
        .where(and(eq(treeEditReceipts.turnId, turnId), isNotNull(treeEditReceipts.draftBranchId)))
        .limit(1);
      return row !== undefined;
    },

    async turnSteps(threadId, turnId, direction) {
      const mine = await tx()
        .select()
        .from(treeEditReceipts)
        .where(and(eq(treeEditReceipts.threadId, threadId), eq(treeEditReceipts.turnId, turnId)))
        .orderBy(desc(treeEditReceipts.seq));
      if (mine.length === 0) return [];
      const reversing = async (ids: string[]) =>
        ids.length === 0
          ? []
          : await tx()
              .select()
              .from(treeEditReceipts)
              .where(inArray(treeEditReceipts.reverses, ids));
      const undoneBy = await reversing(mine.map((row) => row.id));
      const reversedIds = new Set(undoneBy.flatMap((row) => (row.reverses ? [row.reverses] : [])));
      let chosen: (typeof mine)[number][];
      if (direction === "undo") {
        chosen = mine.filter((row) => row.kind !== "undo" && !reversedIds.has(row.id));
      } else {
        // What was taken back: an undo of the reply's receipts that nothing redid since.
        const undos = undoneBy.filter((row) => row.kind === "undo");
        const redone = new Set(
          (await reversing(undos.map((row) => row.id))).flatMap((row) =>
            row.reverses ? [row.reverses] : [],
          ),
        );
        const order = new Map(mine.map((row) => [row.id, row.seq]));
        chosen = undos
          .filter((row) => !redone.has(row.id))
          .sort((a, b) => (order.get(a.reverses ?? "") ?? 0) - (order.get(b.reverses ?? "") ?? 0));
      }
      if (chosen.length === 0) return [];
      const touched = await tx()
        .select({
          receiptId: treeEditReceiptNodes.receiptId,
          nodeId: treeEditReceiptNodes.nodeId,
          beforeAt: treeEditReceiptNodes.beforeAt,
          afterAt: treeEditReceiptNodes.afterAt,
        })
        .from(treeEditReceiptNodes)
        .where(
          inArray(
            treeEditReceiptNodes.receiptId,
            chosen.map((row) => row.id),
          ),
        );
      return chosen.map((row) => {
        const own = touched.filter((node) => node.receiptId === row.id);
        const subject = own.find((node) => node.nodeId === row.nodeId);
        return receiptOf(
          row,
          own.map((node) => node.nodeId),
          0,
          0,
          acrossOf(row, subject),
        );
      });
    },

    async receiptsAt(threadId, shownAt) {
      const rows = await tx()
        .select()
        .from(treeEditReceipts)
        .where(and(eq(treeEditReceipts.threadId, threadId), eq(treeEditReceipts.shownAt, shownAt)))
        .orderBy(desc(treeEditReceipts.seq));
      return rows.map((row) => receiptOf(row, [], 0));
    },

    async historyOf(threadId, nodeId, isDocument) {
      const mine = await tx()
        .select({ receiptId: treeEditReceiptNodes.receiptId, wId: treeEditReceiptNodes.wId })
        .from(treeEditReceiptNodes)
        .where(
          and(eq(treeEditReceiptNodes.threadId, threadId), eq(treeEditReceiptNodes.nodeId, nodeId)),
        )
        .orderBy(desc(treeEditReceiptNodes.wId));
      const ids = mine.map((row) => row.receiptId);
      const stack =
        isDocument && ids.length > 0 ? await textStack(threadId, nodeId) : { undo: [], redo: null };
      const text = { ...stack, commands: await textCommands(threadId, nodeId, stack.undo) };
      if (ids.length === 0) return { undo: [], redo: [], all: [], text };
      const rows = await tx()
        .select()
        .from(treeEditReceipts)
        .where(or(inArray(treeEditReceipts.id, ids), inArray(treeEditReceipts.reverses, ids)));
      const reversed = new Set(rows.flatMap((row) => (row.reverses ? [row.reverses] : [])));
      const touched = await tx()
        .select({
          receiptId: treeEditReceiptNodes.receiptId,
          nodeId: treeEditReceiptNodes.nodeId,
          wId: treeEditReceiptNodes.wId,
          beforeAt: treeEditReceiptNodes.beforeAt,
          afterAt: treeEditReceiptNodes.afterAt,
        })
        .from(treeEditReceiptNodes)
        .where(inArray(treeEditReceiptNodes.receiptId, ids));
      const byId = new Map(rows.map((row) => [row.id, row]));
      const all = mine.flatMap((entry): TreeReceipt[] => {
        const row = byId.get(entry.receiptId);
        if (!row) return [];
        const own = touched.filter((node) => node.receiptId === row.id);
        const subject = own.find((node) => node.nodeId === row.nodeId);
        return [
          receiptOf(
            row,
            own.map((node) => node.nodeId),
            entry.wId,
            subject?.wId ?? entry.wId,
            acrossOf(row, subject),
          ),
        ];
      });
      return {
        undo: all.filter((r) => r.kind !== "undo" && !reversed.has(r.id)),
        redo: all.filter((r) => r.kind === "undo" && !reversed.has(r.id)),
        all,
        text,
      } satisfies NodeHistory;
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

/** A move between two lists: the subject's address before and after. */
function acrossOf(
  row: typeof treeEditReceipts.$inferSelect,
  subject: { beforeAt: string | null; afterAt: string | null } | undefined,
): { from: string; to: string } | undefined {
  return row.acrossLists && subject?.beforeAt && subject.afterAt
    ? { from: subject.beforeAt, to: subject.afterAt }
    : undefined;
}

function receiptOf(
  row: typeof treeEditReceipts.$inferSelect,
  nodes: string[],
  wId: number,
  handle = wId,
  across?: { from: string; to: string },
): TreeReceipt {
  return {
    ...(across ? { across } : {}),
    id: row.id,
    subject: row.nodeId,
    records: row.records,
    op: row.op,
    kind: row.kind,
    reverses: row.reverses,
    draftBranchId: row.draftBranchId,
    turnId: row.turnId,
    commandId: row.commandId,
    shownAt: row.shownAt,
    wId,
    handle,
    nodes,
  };
}
