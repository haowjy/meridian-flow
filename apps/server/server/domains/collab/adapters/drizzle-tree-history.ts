/**
 * The model's tree changes as receipts: the rows its call keeps in the tool call's own
 * transaction (a write ordinal on each node it changed, from the counter the node's text edits
 * take too), the one history of a node `undo` and `revert` choose from, and the Works
 * whose drafts outlive a delete.
 */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { editHandle } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import {
  type Database,
  documentEdits,
  treeEditReceiptNodes,
  treeEditReceipts,
} from "@meridian/database";
import { branches, commands, documentDrafts, works } from "@meridian/database/schema";
import { and, desc, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { AgentTreeHistory, NodeHistory, TreeReceipt } from "../contracts.js";
import { boundCommandId } from "./drizzle-document-edits.js";

export function createDrizzleTreeHistory(
  db: Database,
  journal: Pick<UpdateJournal, "reserveWriteOrdinal">,
  /** The text engine's own stack of a document for a chat: ordinals of what Undo would take. */
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
  const reversing = async (ids: string[]) =>
    ids.length === 0
      ? []
      : await tx().select().from(treeEditReceipts).where(inArray(treeEditReceipts.reverses, ids));
  /**
   * The reply's receipts, newest first; those reversing them; and of those, the card's Undo
   * receipts. The model's own undo of one of the reply's changes is part of what the reply did,
   * so it is not among them.
   */
  const turnReceipts = async (threadId: ThreadId, turnId: TurnId) => {
    const mine = await tx()
      .select()
      .from(treeEditReceipts)
      .where(and(eq(treeEditReceipts.threadId, threadId), eq(treeEditReceipts.turnId, turnId)))
      .orderBy(desc(treeEditReceipts.seq));
    const undoneBy = await reversing(mine.map((row) => row.id));
    const commandIds = undoneBy.flatMap((row) => (row.commandId ? [row.commandId] : []));
    const cardCommands = new Set(
      commandIds.length === 0
        ? []
        : (
            await tx()
              .select({ id: commands.id })
              .from(commands)
              .where(and(inArray(commands.id, commandIds), eq(commands.kind, "reverse_turn")))
          ).map((row) => row.id as string),
    );
    const byCard = undoneBy.filter(
      (row) => row.kind === "undo" && row.commandId !== null && cardCommands.has(row.commandId),
    );
    return { mine, undoneBy, byCard };
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
          copiedFrom: node.copiedFrom ?? null,
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

    async turnSteps(threadId, turnId) {
      const { mine, undoneBy, byCard } = await turnReceipts(threadId, turnId);
      const reversedIds = new Set(undoneBy.flatMap((row) => (row.reverses ? [row.reverses] : [])));
      const undoneByCard = new Set(byCard.map((row) => row.reverses)).size;
      const chosen = mine.filter((row) => row.kind !== "undo" && !reversedIds.has(row.id));
      if (chosen.length === 0) return { open: [], undoneByCard };
      const touched = await tx()
        .select({
          receiptId: treeEditReceiptNodes.receiptId,
          nodeId: treeEditReceiptNodes.nodeId,
        })
        .from(treeEditReceiptNodes)
        .where(
          inArray(
            treeEditReceiptNodes.receiptId,
            chosen.map((row) => row.id),
          ),
        );
      return {
        open: chosen.map((row) => {
          const own = touched.filter((node) => node.receiptId === row.id);
          return receiptOf(
            row,
            own.map((node) => node.nodeId),
            0,
          );
        }),
        undoneByCard,
      };
    },

    async nodeLeftAt(threadId, at, holds) {
      const [written] = await tx()
        .select({ node: treeEditReceipts.nodeId })
        .from(treeEditReceipts)
        .where(
          and(
            eq(treeEditReceipts.threadId, threadId),
            eq(treeEditReceipts.shownAt, at),
            or(
              eq(treeEditReceipts.op, "delete"),
              and(eq(treeEditReceipts.op, "create"), eq(treeEditReceipts.kind, "undo")),
            ),
          ),
        )
        .orderBy(desc(treeEditReceipts.seq))
        .limit(1);
      // What a receipt took from the path it was written at comes first: a blocker moved aside
      // from a path never stands in for what was deleted there.
      if (written) return { node: written.node, folder: at.endsWith("/") };
      // A folder's move writes a row for the folder only, so what was inside it is found by the
      // folder's address above `at` (a folder's address ends in "/"). A folder's row touched `at`
      // only when that folder holds a node at the rest of `at` now; the rows that touched it are
      // walked in order, carrying what stood at `at`.
      const touched = (address: string | null, node: string) =>
        address === at ||
        (address !== null &&
          address.endsWith("/") &&
          at.startsWith(address) &&
          holds(node, at.slice(address.length)));
      const rows = await tx()
        .select({
          node: treeEditReceiptNodes.nodeId,
          beforeAt: treeEditReceiptNodes.beforeAt,
          afterAt: treeEditReceiptNodes.afterAt,
        })
        .from(treeEditReceiptNodes)
        .innerJoin(treeEditReceipts, eq(treeEditReceipts.id, treeEditReceiptNodes.receiptId))
        .where(
          and(
            eq(treeEditReceiptNodes.threadId, threadId),
            or(
              eq(treeEditReceiptNodes.beforeAt, at),
              eq(treeEditReceiptNodes.afterAt, at),
              and(
                like(treeEditReceiptNodes.beforeAt, "%/"),
                sql`starts_with(${at}, ${treeEditReceiptNodes.beforeAt})`,
              ),
              and(
                like(treeEditReceiptNodes.afterAt, "%/"),
                sql`starts_with(${at}, ${treeEditReceiptNodes.afterAt})`,
              ),
            ),
          ),
        )
        .orderBy(treeEditReceipts.seq, desc(sql`length(${treeEditReceiptNodes.beforeAt})`));
      // Before the chat's first row, something may stand at `at`.
      let standing = true;
      let left: { node: string; folder: boolean } | null = null;
      for (const row of rows) {
        if (row.beforeAt === row.afterAt) continue;
        if (standing && touched(row.beforeAt, row.node)) {
          left = { node: row.node, folder: (row.beforeAt as string).endsWith("/") };
          standing = false;
        }
        if (touched(row.afterAt, row.node)) standing = true;
      }
      return left;
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
      const stack = isDocument && ids.length > 0 ? await textStack(threadId, nodeId) : { undo: [] };
      const text = { ...stack, commands: await textCommands(threadId, nodeId, stack.undo) };
      if (ids.length === 0) return { undo: [], all: [], text };
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
          ),
        ];
      });
      return {
        undo: all.filter((r) => r.kind !== "undo" && !reversed.has(r.id)),
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

function receiptOf(
  row: typeof treeEditReceipts.$inferSelect,
  nodes: string[],
  wId: number,
  handle = wId,
): TreeReceipt {
  return {
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
