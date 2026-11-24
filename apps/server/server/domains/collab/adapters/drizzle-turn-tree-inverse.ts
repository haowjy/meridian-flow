/**
 * The tree half of a card's Undo of a reply: the reply's live tree receipts (the model's moves,
 * renames, deletes and creates; a drafted one is its restore's), taken back by the package's `takeBackAll` in the list that
 * holds each node, as one step of the card's command. The receipts are the history the
 * model's own `undo` chooses from (`tree_edit_receipts` and their `reverses` links), and each
 * reversal is recorded as a receipt in turn, so the model's `undo` and the card's see one order.
 */

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

/** What a reversal needs from the locks' step: which lists, Works and documents it will touch. */
export type TreePlan = {
  /** The receipts to take back. */
  steps: TreeReceipt[];
  /**
   * The receipts whose records' opposites all stand already (the writer restored what the
   * model deleted): the Undo records them as taken back, writing nothing to the list.
   */
  taken: TreeReceipt[];
  /** How many of the reply's receipts an earlier card Undo took back. */
  undoneByCard: number;
  /**
   * The owners of the sources the Undo changes, whose locks come before the lists': what
   * `stayed` was judged from, and what `run` judges under the locks.
   */
  owners: TreeOwners;
  /** The lists that hold the steps' nodes, to be locked before any document key. */
  lists: TreeList[];
  /** The steps' live documents, for the edit grants (a restore is its own). */
  documents: { documentId: string; restore: boolean }[];
  /**
   * Documents created in this turn: their text stays with the document.
   */
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

export type TurnTreeInverse = ReturnType<typeof createTurnTreeInverse>;

export function createTurnTreeInverse(deps: {
  db: Database;
  treeLists: Pick<TreeListStore, "read" | "submit">;
  history: () => Pick<AgentTreeHistory, "turnSteps" | "recordAgentTreeChange">;
}) {
  const db = () => currentDrizzleDb(deps.db);

  /**
   * What became of each node's tree change the turn drafted (`draftedFates`, which follows a
   * restored Discard's copies): `pending` while one of the node's records still waits, else
   * `applied` when one landed, else `undone` when the turn's restore in force (`restored`) took
   * it, else `discarded` (a change a later one replaced is discarded too). The lists are found
   * once for the turn's nodes, and each list is read once for the turn's own record ids.
   */
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

  /**
   * The reply's receipts by what the card's Undo would do with each, judged by `takeBackAll` on
   * the lists as they stand: the steps it takes, those already taken, and those that stay.
   */
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
    // A drafted change is the turn's restore's (`drizzle-turn-restore.ts`), not the card's Undo's.
    const open = steps.filter((step) => !step.draftId);
    if (open.length === 0) return { ...NO_TREE_STEPS, undoneByCard, createdDocuments };
    const ids = open.map((step) => step.subject);
    const listOf = await treeListsOfNodes(deps.db, [...new Set(ids)]);
    const subjects = new Set(
      (
        await db().select({ id: documents.id }).from(documents).where(inArray(documents.id, ids))
      ).map((row) => row.id as string),
    );
    // Each subject's live row: absent for a node only a Work shows, or one the Trash purged.
    const live = new Map(
      (
        await db()
          .select({ id: treeNodes.id, trashRecord: treeNodes.trashRecord })
          .from(treeNodes)
          .where(inArray(treeNodes.id, ids))
      ).map((row) => [row.id as string, row.trashRecord]),
    );
    // Each record's report, one read of each list, in the order the Undo takes the records; the
    // sources they name say whose notes the Undo changes, and those owners judge what stays.
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
    // Which records an owner holds decides what the others read, so once an owner is closed
    // they are read again without the held ones, and what that names is judged in turn.
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
    // A delete's Undo brings its node back: the restore is the node's own grant.
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
        // A document in Trash takes no edit grant but its own restore.
        const placed = live.has(step.subject) && live.get(step.subject) === null;
        return subjects.has(step.subject) && (restore ? undoesSubject(step) : placed)
          ? [{ documentId: step.subject, restore }]
          : [];
      }),
      createdDocuments,
    };
  }

  /**
   * Takes the steps back in the order given (the caller holds the lists' keys, the Works and
   * the documents). A receipt something later changed or whose node is gone is skipped. One whose records'
   * opposites all stand already, the plan's `taken` among them, is recorded as taken back with no
   * record of its own. Returns how many of the reply's receipts stand taken back after it, an
   * earlier card Undo's among them. The receipts one list holds
   * go back in one update of it: every browser showing the list redraws its tree once for the
   * whole Undo, not once a receipt.
   */
  async function run(
    plan: Pick<TreePlan, "steps" | "taken" | "undoneByCard" | "owners">,
    input: {
      threadId: ThreadId;
      userId: UserId | undefined;
    },
  ): Promise<{ reversed: number }> {
    const actor = input.userId ? `user:${input.userId}` : "system";
    // Under the owners' locks: what they say now is what commits.
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

    // Consecutive receipts in one list, taken back together.
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
          // The answers about sources the locks missed were guesses: nothing of this commits.
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

/**
 * The steps of an Undo of the receipts, in the order the press takes them: each receipt's records
 * newest first, in Live. An estimate walks these same steps, so it equals
 * the press. A record belongs to one receipt: a walk answers an id once.
 */
const stepsOf = (receipts: readonly TreeReceipt[]): UndoStep[] =>
  receipts.flatMap((receipt) =>
    receipt.records.toReversed().map((entry) => ({ id: entry.record, view: LIVE })),
  );

/** What the Undo of the receipts' records would do, writing nothing (`stepsOf`'s walk). */
const reportsOf = (
  writer: TreeWriter,
  receipts: readonly TreeReceipt[],
  closed?: (source: string) => boolean,
) => undoReports(writer, stepsOf(receipts), closed);
