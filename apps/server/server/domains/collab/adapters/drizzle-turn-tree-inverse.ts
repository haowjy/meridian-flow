import type { CommandId, DraftId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type { TurnDraftState } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, treeEditReceipts, treeNodes } from "@meridian/database/schema";
import {
  changeUndone,
  draftedFates,
  LIVE,
  newestDrafted,
  settledRecords,
  type TakenBack,
  type TreeWriter,
  takeBackAll,
  type UndoAnswer,
  type UndoReport,
  type UndoStep,
  undoReports,
} from "@meridian/project-tree";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  answerOf,
  closedAnswer,
  type Learned,
  NO_OWNERS,
  type TreeOwners,
  treeOwners,
} from "../../../shared/tree-owners.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { AgentTreeHistory, TreeReceipt, TreeReceiptInput } from "../contracts.js";
import { treeCommand, treeListOfNode, treeListsOfNodes } from "./drizzle-draft-tree-lists.js";

export type TreePlan = {
  steps: TreeReceipt[];
  taken: TreeReceipt[];
  undoneByCard: number;
  owners: TreeOwners;
  lists: TreeList[];
  documents: { documentId: string; restore: boolean }[];
  createdDocuments: string[];
};

export const NO_TREE_STEPS: TreePlan = {
  steps: [],
  taken: [],
  undoneByCard: 0,
  owners: NO_OWNERS,
  lists: [],
  documents: [],
  createdDocuments: [],
};

export function createTurnTreeInverse(deps: {
  db: Database;
  treeLists: Pick<TreeListStore, "read" | "submit">;
  history: () => Pick<AgentTreeHistory, "turnSteps" | "recordAgentTreeChange">;
}) {
  const db = () => currentDrizzleDb(deps.db);

  async function draftStates(
    threadId: ThreadId,
    turnId: TurnId,
    restored: readonly { draft: DraftId; press: CommandId }[],
  ): Promise<Record<string, TurnDraftState>> {
    const restores = new Set(restored.map(({ draft, press }) => treeCommand(press, draft)));
    const receipts = await db()
      .select({ records: treeEditReceipts.records })
      .from(treeEditReceipts)
      .where(
        and(
          eq(treeEditReceipts.threadId, threadId),
          eq(treeEditReceipts.turnId, turnId),
          eq(treeEditReceipts.kind, "write"),
          isNotNull(treeEditReceipts.draftId),
        ),
      );
    const entries = receipts.flatMap((receipt) => receipt.records);
    const listOf = await treeListsOfNodes(deps.db, [...new Set(entries.map((e) => e.node))]);
    const byList = new Map<
      string,
      { list: TreeList; records: { record: string; node: string }[] }
    >();
    for (const entry of entries) {
      const list = listOf.get(entry.node);
      if (!list) continue;
      const key = JSON.stringify(list);
      const known = byList.get(key) ?? { list, records: [] };
      known.records.push(entry);
      byList.set(key, known);
    }
    const states: Record<string, TurnDraftState> = {};
    const rank = { discarded: 0, undone: 1, applied: 2, pending: 3 } as const;
    for (const { list, records } of byList.values()) {
      const ids = records.map((entry) => entry.record);
      const fates = await deps.treeLists.read<Map<string, TurnDraftState>>({
        lists: [list],
        view: ([end]) => {
          if (!end) return new Map();
          const { doc } = end.writer;
          const settled = settledRecords(doc);
          const newest = newestDrafted(doc, ids);
          const states = new Map<string, TurnDraftState>();
          for (const [id, fate] of draftedFates(doc, ids)) {
            const by = settled.get(newest.get(id)?.id ?? id)?.command;
            states.set(
              id,
              fate === "applied" || fate === "pending"
                ? fate
                : by && restores.has(by)
                  ? "undone"
                  : "discarded",
            );
          }
          return states;
        },
      });
      for (const { record, node } of records) {
        const state = fates.get(record) ?? "discarded";
        const was = states[node] as keyof typeof rank | undefined;
        if (!was || rank[state] > rank[was]) states[node] = state;
      }
    }
    return states;
  }

  async function plan(
    threadId: ThreadId,
    turnId: TurnId,
    learned?: Pick<Learned, "sources" | "owners">,
  ): Promise<TreePlan> {
    const creates = await db()
      .select({ id: treeEditReceipts.nodeId })
      .from(treeEditReceipts)
      .where(
        and(
          eq(treeEditReceipts.threadId, threadId),
          eq(treeEditReceipts.turnId, turnId),
          eq(treeEditReceipts.kind, "write"),
          eq(treeEditReceipts.op, "create"),
        ),
      );
    const createdDocuments = creates.map((row) => row.id as string);
    const { open: steps, undoneByCard } = await deps.history().turnSteps(threadId, turnId);
    const open = steps.filter((step) => !step.draftId);
    if (open.length === 0) return { ...NO_TREE_STEPS, undoneByCard, createdDocuments };
    const ids = open.map((step) => step.subject);
    const listOf = await treeListsOfNodes(deps.db, [...new Set(ids)]);
    const subjects = new Set(
      (
        await db().select({ id: documents.id }).from(documents).where(inArray(documents.id, ids))
      ).map((row) => row.id as string),
    );
    const live = new Map(
      (
        await db()
          .select({ id: treeNodes.id, trashRecord: treeNodes.trashRecord })
          .from(treeNodes)
          .where(inArray(treeNodes.id, ids))
      ).map((row) => [row.id as string, row.trashRecord]),
    );
    const byList = new Map<string, { list: TreeList; receipts: TreeReceipt[] }>();
    for (const step of open) {
      const list = listOf.get(step.subject);
      if (!list) continue;
      const key = JSON.stringify(list);
      const entry = byList.get(key) ?? { list, receipts: [] };
      entry.receipts.push(step);
      byList.set(key, entry);
    }
    const reportsUnder = async (closed?: (source: string) => boolean) => {
      const reports = new Map<string, UndoReport>();
      for (const { list, receipts } of byList.values()) {
        const read = await deps.treeLists.read({
          lists: [list],
          view: ([end]) =>
            end ? reportsOf(end.writer, receipts, closed) : new Map<string, UndoReport>(),
        });
        for (const [record, report] of read) reports.set(record, report);
      }
      return reports;
    };
    const sourcesOf = (reports: ReadonlyMap<string, UndoReport>) =>
      [...reports.values()].flatMap((report) => report.sources);
    let reports = await reportsUnder();
    const sources = new Set([...(learned?.sources ?? []), ...sourcesOf(reports)]);
    let owners = await treeOwners(deps.db, sources, learned?.owners);
    let judge = await owners.judge();
    if (sourcesOf(reports).some(judge.closed))
      for (;;) {
        reports = await reportsUnder(judge.closed);
        const grown = sourcesOf(reports).filter((source) => !sources.has(source));
        if (grown.length === 0) break;
        for (const source of grown) sources.add(source);
        owners = await treeOwners(deps.db, sources, learned?.owners);
        judge = await owners.judge();
      }
    const answers = new Map<string, UndoAnswer>(
      [...reports].map(([record, report]) => [record, answerOf(report, judge)]),
    );
    const fates = new Map<TreeReceipt, ReturnType<typeof changeUndone> | "purged">();
    for (const step of open) {
      const own = step.records.map((entry) => answers.get(entry.record));
      fates.set(
        step,
        own.some((answer) => answer === undefined) ? "purged" : changeUndone(own as UndoAnswer[]),
      );
    }
    const acting = open.filter((step) => fates.get(step) === "acts");
    const lists = new Map<string, TreeList>();
    for (const step of acting) {
      const list = listOf.get(step.subject);
      if (list) lists.set(JSON.stringify(list), list);
    }
    const restores = (step: TreeReceipt) => step.op === "delete";
    const undoesSubject = (step: TreeReceipt) =>
      step.records.some(
        (entry) => entry.node === step.subject && answers.get(entry.record) === "undoes",
      );
    return {
      steps: acting,
      taken: open.filter((step) => fates.get(step) === "taken"),
      undoneByCard,
      owners,
      lists: [...lists.values()],
      documents: acting.flatMap((step) => {
        const restore = restores(step);
        const placed = live.has(step.subject) && live.get(step.subject) === null;
        return subjects.has(step.subject) && (restore ? undoesSubject(step) : placed)
          ? [{ documentId: step.subject, restore }]
          : [];
      }),
      createdDocuments,
    };
  }

  async function run(
    plan: Pick<TreePlan, "steps" | "taken" | "undoneByCard" | "owners">,
    input: {
      threadId: ThreadId;
      userId: UserId | undefined;
    },
  ): Promise<{ reversed: number }> {
    const actor = input.userId ? `user:${input.userId}` : "system";
    const judge = await plan.owners.judge();
    let reversed = plan.undoneByCard;
    const record = (receipt: TreeReceipt, fields: Pick<TreeReceiptInput, "nodes" | "records">) =>
      deps.history().recordAgentTreeChange({
        subject: receipt.subject,
        op: receipt.op,
        threadId: input.threadId,
        ...(receipt.turnId ? { turnId: receipt.turnId as TurnId } : {}),
        shownAt: receipt.shownAt ?? "",
        reverses: { kind: "undo", receipt: receipt.id },
        ...fields,
      });

    const nodesOf = (receipt: TreeReceipt) =>
      receipt.nodes.map((nodeId) => ({ nodeId, beforeAt: null, afterAt: null }));
    for (const receipt of plan.taken) {
      reversed++;
      await record(receipt, { nodes: nodesOf(receipt), records: [] });
    }

    let batch: { list: TreeList; receipts: TreeReceipt[] } | null = null;
    const flush = async () => {
      if (!batch) return;
      const { list, receipts } = batch;
      batch = null;
      const { result } = await deps.treeLists.submit({
        lists: [list],
        make: ([{ writer }]) => {
          const walked = takeBackAll(writer, actor, stepsOf(receipts), judge.closed);
          const taken = receipts.map((receipt) => {
            const made: { record: string; node: string }[] = [];
            const answers: UndoAnswer[] = [];
            for (const entry of receipt.records.toReversed()) {
              const back = walked.get(entry.record) as TakenBack;
              if (typeof back === "string") answers.push(back);
              else if ("closed" in back) {
                answers.push(closedAnswer(judge, back.closed));
              } else {
                answers.push("undoes");
                made.push({ record: back.id, node: entry.node });
              }
            }
            const fate = changeUndone(answers.filter((answer) => answer !== "undoes"));
            return {
              receipt,
              made,
              stayed: fate !== "taken",
            };
          });
          judge.assertLocked();
          return taken;
        },
      });
      for (const { receipt, made, stayed } of result) {
        if (made.length === 0 && stayed) continue;
        reversed++;
        await record(receipt, { nodes: nodesOf(receipt), records: made });
      }
    };

    for (const receipt of plan.steps) {
      const list = await treeListOfNode(deps.db, receipt.subject);
      if (!list) continue;
      if (batch && JSON.stringify(batch.list) === JSON.stringify(list))
        batch.receipts.push(receipt);
      else {
        await flush();
        batch = { list, receipts: [receipt] };
      }
    }
    await flush();
    return { reversed };
  }

  return { plan, run, draftStates };
}

const stepsOf = (receipts: readonly TreeReceipt[]): UndoStep[] =>
  receipts.flatMap((receipt) =>
    receipt.records.toReversed().map((entry) => ({ id: entry.record, view: LIVE })),
  );

const reportsOf = (
  writer: TreeWriter,
  receipts: readonly TreeReceipt[],
  closed?: (source: string) => boolean,
) => undoReports(writer, stepsOf(receipts), closed);
