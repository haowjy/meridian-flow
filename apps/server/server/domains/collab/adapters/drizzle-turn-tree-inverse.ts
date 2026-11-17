/**
 * The tree half of a card's Undo of a reply: the reply's tree receipts (the model's moves,
 * renames, deletes and creates), taken back by the package's `takeBackAll` in the list that
 * holds each node, as one step of the card's command. The receipts are the history the
 * model's own `undo` chooses from (`tree_edit_receipts` and their `reverses` links), and each
 * reversal is recorded as a receipt in turn, so the model's `undo` and the card's see one order.
 */

import type { BranchId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type { TurnInverseSkip, TurnTreeState } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, treeEditReceipts, treeNodes } from "@meridian/database/schema";
import {
  appliedBy,
  changeUndone,
  type DraftedFate,
  draftedFates,
  LIVE,
  newestDrafted,
  type TakenBack,
  type TreeWriter,
  takeBackAll,
  type UndoAnswer,
  type UndoReport,
  type UndoStep,
  undoReports,
  type View,
} from "@meridian/project-tree";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  answerOf,
  type ClosedSource,
  closedAnswer,
  type Learned,
  NO_OWNERS,
  type TreeOwners,
  treeOwners,
} from "../../../shared/tree-owners.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import { placedNodesSql } from "../../context/tree/tree-addresses.js";
import type { AgentTreeHistory, TreeReceipt, TreeReceiptInput } from "../contracts.js";
import { treeListOfNode, treeListsOfNodes } from "./drizzle-branch-tree-lists.js";

/** Why a receipt's Undo leaves it as it is. */
type Stayed = "changed_since" | "purged" | "closed";

const viewOf = (receipt: TreeReceipt): View =>
  receipt.draftBranchId ? { draft: receipt.draftBranchId } : LIVE;

/** A receipt that stayed. `closed` is the owner the Undo would have changed, when the receipt stayed for it. */
function stayedSkip(receipt: TreeReceipt, cause: Stayed, closed?: ClosedSource): TurnInverseSkip {
  const skip = {
    kind: "tree" as const,
    documentId: receipt.subject,
    uri: receipt.shownAt ?? receipt.subject,
    at: receipt.shownAt,
    op: receipt.op,
  };
  return cause === "closed"
    ? {
        ...skip,
        cause: "returned",
        ...(closed ? { why: closed.why, ...(closed.owner ? { owner: closed.owner } : {}) } : {}),
      }
    : { ...skip, cause };
}

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
   * The receipts that stay, with why: something changed them since, their node is gone, or an
   * owner is closed (`returned`, with the owner).
   */
  stayed: TurnInverseSkip[];
  /**
   * The owners of the sources the Undo changes, whose locks come before the lists': what
   * `stayed` was judged from, and what `run` judges under the locks.
   */
  owners: TreeOwners;
  /** The lists that hold the steps' nodes, to be locked before any document key. */
  lists: TreeList[];
  /** The Works whose branches a drafted step writes. */
  branches: BranchId[];
  /** The steps' documents, each where it is reversed, for the edit grants (a restore is its own). */
  documents: { documentId: string; branchId: BranchId | null; restore: boolean }[];
  /**
   * Documents created in this turn: their text stays with the document.
   */
  createdDocuments: string[];
};

export const NO_TREE_STEPS: TreePlan = {
  steps: [],
  taken: [],
  undoneByCard: 0,
  stayed: [],
  owners: NO_OWNERS,
  lists: [],
  branches: [],
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
   * `applied` when one landed, else `replaced` or `discarded`. The lists are found once for the
   * turn's nodes, and each list is read once for the turn's own record ids.
   */
  async function draftStates(
    threadId: ThreadId,
    turnId: TurnId,
  ): Promise<{ states: Record<string, TurnTreeState>; appliedBy: Record<string, string[]> }> {
    const receipts = await db()
      .select({ records: treeEditReceipts.records })
      .from(treeEditReceipts)
      .where(
        and(
          eq(treeEditReceipts.threadId, threadId),
          eq(treeEditReceipts.turnId, turnId),
          eq(treeEditReceipts.kind, "write"),
          isNotNull(treeEditReceipts.draftBranchId),
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
    const states: Record<string, TurnTreeState> = {};
    // Every Apply that took one of a node's records: two Applies on one node are both in force.
    const commands: Record<string, string[]> = {};
    const rank = { discarded: 0, replaced: 1, applied: 2, pending: 3 } as const;
    for (const { list, records } of byList.values()) {
      const ids = records.map((entry) => entry.record);
      const read = await deps.treeLists.read<{
        fates: Map<string, DraftedFate>;
        by: Map<string, string>;
      }>({
        lists: [list],
        view: ([end]) =>
          end
            ? { fates: draftedFates(end.writer.doc, ids), by: appliedBy(end.writer.doc, ids) }
            : { fates: new Map(), by: new Map() },
      });
      for (const { record, node } of records) {
        const fate = read.fates.get(record) ?? "discarded";
        const was = states[node];
        if (!was || rank[fate] > rank[was]) states[node] = fate;
        const command = read.by.get(record);
        if (command && !commands[node]?.includes(command))
          commands[node] = [...(commands[node] ?? []), command];
      }
    }
    return { states, appliedBy: commands };
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
    const { open: recorded, undoneByCard } = await deps.history().turnSteps(threadId, turnId);
    if (recorded.length === 0) return { ...NO_TREE_STEPS, undoneByCard, createdDocuments };
    const ids = recorded.map((step) => step.subject);
    const listOf = await treeListsOfNodes(deps.db, [...new Set(ids)]);
    const draftedBy = new Map<string, { list: TreeList; steps: TreeReceipt[] }>();
    for (const step of recorded) {
      const list = listOf.get(step.subject);
      if (!list || !step.draftBranchId) continue;
      const key = JSON.stringify(list);
      const entry = draftedBy.get(key) ?? { list, steps: [] };
      entry.steps.push(step);
      draftedBy.set(key, entry);
    }
    // A drafted change an Apply took is the Apply's to take back (its Un-Apply, which the card
    // sends): the card's own Undo leaves it, and says nothing of it. A restored Discard put a copy
    // of a drafted change in the Work's branch as it is now, which may be a new one: the change is
    // judged and taken back there.
    const tookIt = new Set<TreeReceipt>();
    const branchNow = new Map<TreeReceipt, string>();
    for (const { list, steps } of draftedBy.values()) {
      const records = steps.flatMap((step) => step.records.map((entry) => entry.record));
      const read = await deps.treeLists.read({
        lists: [list],
        view: ([end]) =>
          end
            ? {
                by: appliedBy(end.writer.doc, records),
                copies: newestDrafted(end.writer.doc, records),
              }
            : {
                by: new Map<string, string>(),
                copies: new Map<string, { draft: string | null }>(),
              },
      });
      for (const step of steps) {
        if (step.records.every((entry) => read.by.has(entry.record))) tookIt.add(step);
        const branch = step.records
          .map((entry) => read.copies.get(entry.record)?.draft)
          .find(Boolean);
        if (branch) branchNow.set(step, branch);
      }
    }
    const open = recorded.map((step) => {
      const draftBranchId = branchNow.get(step) ?? step.draftBranchId;
      return { ...step, draftBranchId };
    });
    const applied = new Set(open.filter((_, at) => tookIt.has(recorded[at] as TreeReceipt)));
    // A drafted Undo is applicable while its branch still places the node; once a Discard took it
    // out there is no file to ask a grant about and nothing to reverse.
    const held = new Set<string>();
    const draftedIn = new Map<string, string[]>();
    for (const step of open)
      if (step.draftBranchId)
        draftedIn.set(step.draftBranchId, [
          ...(draftedIn.get(step.draftBranchId) ?? []),
          step.subject,
        ]);
    for (const [branchId, nodes] of draftedIn)
      for (const row of await db().execute<{ id: string }>(sql`
        SELECT n.id::text AS id FROM ${placedNodesSql({ kind: "branch", branchId: branchId as BranchId })} n
        WHERE n.id IN (${sql.join(
          nodes.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`))
        held.add(`${branchId}:${row.id}`);
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
      if (
        !list ||
        applied.has(step) ||
        (step.draftBranchId && !held.has(`${step.draftBranchId}:${step.subject}`))
      )
        continue;
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
    // The owner a receipt's closed record would change: what the card says stayed.
    const closedOf = (step: TreeReceipt): ClosedSource | undefined => {
      for (const entry of step.records) {
        const source = reports.get(entry.record)?.sources.find(judge.closed);
        const fate = source === undefined ? null : judge.fate(source);
        if (fate?.kind === "closed") return fate;
      }
      return undefined;
    };
    // A drafted receipt its Work's branch no longer holds was discarded: like discarded text, it
    // is neither taken back nor a part that stayed.
    const fates = new Map<TreeReceipt, ReturnType<typeof changeUndone> | "discarded" | "applied">();
    for (const step of open) {
      const own = step.records.map((entry) => answers.get(entry.record));
      fates.set(
        step,
        applied.has(step)
          ? "applied"
          : step.draftBranchId && !held.has(`${step.draftBranchId}:${step.subject}`)
            ? "discarded"
            : own.some((answer) => answer === undefined)
              ? "purged"
              : changeUndone(own as UndoAnswer[]),
      );
    }
    const steps = open.filter((step) => fates.get(step) === "acts");
    const lists = new Map<string, TreeList>();
    for (const step of steps) {
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
      steps,
      taken: open.filter((step) => fates.get(step) === "taken"),
      undoneByCard,
      owners,
      stayed: open.flatMap((step) => {
        const fate = fates.get(step);
        return fate === "changed_since" || fate === "purged" || fate === "closed"
          ? [stayedSkip(step, fate, fate === "closed" ? closedOf(step) : undefined)]
          : [];
      }),
      lists: [...lists.values()],
      branches: [
        ...new Set(steps.flatMap((step) => (step.draftBranchId ? [step.draftBranchId] : []))),
      ] as BranchId[],
      documents: steps.flatMap((step) => {
        const restore = restores(step);
        // A document in Trash takes no edit grant but its own restore.
        const placed = live.has(step.subject) && live.get(step.subject) === null;
        return subjects.has(step.subject) &&
          (step.draftBranchId || (restore ? undoesSubject(step) : placed))
          ? [
              {
                documentId: step.subject,
                branchId: step.draftBranchId as BranchId | null,
                restore,
              },
            ]
          : [];
      }),
      createdDocuments,
    };
  }

  /**
   * Takes the steps back in the order given (the caller holds the lists' keys, the Works and
   * the documents). A receipt something later changed (`changed_since`) or whose node is gone
   * (`purged`) is skipped, and one partly taken back reports as skipped too. One whose records'
   * opposites all stand already, the plan's `taken` among them, is recorded as taken back with no
   * record of its own. Returns how many of the reply's receipts stand taken back after it, an
   * earlier card Undo's among them. The receipts one list holds
   * go back in one update of it: every browser showing the list redraws its tree once for the
   * whole Undo, not once a receipt.
   */
  async function run(
    plan: Pick<TreePlan, "steps" | "taken" | "undoneByCard" | "stayed" | "owners">,
    input: {
      threadId: ThreadId;
      userId: UserId | undefined;
    },
  ): Promise<{ reversed: number; skips: TurnInverseSkip[] }> {
    const actor = input.userId ? `user:${input.userId}` : "system";
    const skips: TurnInverseSkip[] = [...plan.stayed];
    // Under the owners' locks: what they say now is what commits.
    const judge = await plan.owners.judge();
    let reversed = plan.undoneByCard;
    const record = (
      receipt: TreeReceipt,
      fields: Pick<TreeReceiptInput, "nodes" | "records"> &
        Partial<Pick<TreeReceiptInput, "draftBranchId">>,
    ) =>
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
            let inLive = receipt.draftBranchId === null;
            let closed: ClosedSource | undefined;
            for (const entry of receipt.records.toReversed()) {
              const back = walked.get(entry.record) as TakenBack;
              if (typeof back === "string") answers.push(back);
              else if ("closed" in back) {
                answers.push(closedAnswer(judge, back.closed));
                const fate = judge.fate(back.closed);
                if (fate?.kind === "closed") closed ??= fate;
              } else {
                answers.push("undoes");
                if (back.draft === null) inLive = true;
                made.push({ record: back.id, node: entry.node });
              }
            }
            const fate = changeUndone(answers.filter((answer) => answer !== "undoes"));
            return {
              receipt,
              made,
              stayed: fate === "taken" ? null : (fate as Stayed),
              inLive,
              closed,
            };
          });
          // The answers about sources the locks missed were guesses: nothing of this commits.
          judge.assertLocked();
          return taken;
        },
      });
      for (const { receipt, made, stayed, inLive, closed } of result) {
        if (stayed) skips.push(stayedSkip(receipt, stayed, closed));
        if (made.length === 0 && stayed) continue;
        reversed++;
        await record(receipt, {
          nodes: nodesOf(receipt),
          records: made,
          ...(receipt.draftBranchId && !inLive
            ? { draftBranchId: receipt.draftBranchId as BranchId }
            : {}),
        });
      }
    };

    for (const receipt of plan.steps) {
      const list = await treeListOfNode(deps.db, receipt.subject);
      if (!list) {
        skips.push(stayedSkip(receipt, "purged"));
        continue;
      }
      if (batch && JSON.stringify(batch.list) === JSON.stringify(list))
        batch.receipts.push(receipt);
      else {
        await flush();
        batch = { list, receipts: [receipt] };
      }
    }
    await flush();
    return { reversed, skips };
  }

  return { plan, run, draftStates };
}

/**
 * The steps of an Undo of the receipts, in the order the press takes them: each receipt's records
 * newest first, each in its receipt's own view. An estimate walks these same steps, so it equals
 * the press. A record belongs to one receipt: a walk answers an id once.
 */
const stepsOf = (receipts: readonly TreeReceipt[]): UndoStep[] =>
  receipts.flatMap((receipt) =>
    receipt.records.toReversed().map((entry) => ({ id: entry.record, view: viewOf(receipt) })),
  );

/** What the Undo of the receipts' records would do, writing nothing (`stepsOf`'s walk). */
const reportsOf = (
  writer: TreeWriter,
  receipts: readonly TreeReceipt[],
  closed?: (source: string) => boolean,
) => undoReports(writer, stepsOf(receipts), closed);
