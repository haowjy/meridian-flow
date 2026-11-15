/**
 * The tree half of a card's Undo or Redo of a reply: the reply's tree receipts (the model's
 * moves, renames, deletes and creates), taken back by the package's `undoChange` in the list
 * that holds each node, as one step of the card's command. The receipts are the history the
 * model's own `undo` chooses from (`tree_edit_receipts` and their `reverses` links), and each
 * reversal is recorded as a receipt in turn, so the model's `undo` and the card's see one order.
 */

import type { BranchId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type { TurnDraftState, TurnInverseSkip } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  documents,
  projects,
  threads,
  treeEditReceipts,
  treeNodes,
} from "@meridian/database/schema";
import {
  deleteStands,
  LIVE,
  lastSettlements,
  listRecords,
  undoChange,
  type View,
} from "@meridian/project-tree";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import { placedNodesSql } from "../../context/tree/tree-addresses.js";
import type {
  AgentTreeHistory,
  MoveBackAcrossLists,
  TreeReceipt,
  TreeReceiptInput,
} from "../contracts.js";
import { treeListOfNode } from "./drizzle-branch-tree-lists.js";

/** What a reversal needs from the locks' step: which lists, Works and documents it will touch. */
export type TreePlan = {
  /** The steps to reverse. */
  steps: TreeReceipt[];
  /**
   * Steps with nothing left to act on, skipped and never run: a drafted Undo whose Work's branch
   * no longer holds the node (a Discard took it), or a restore in live whose delete no longer
   * holds the node in Trash (the writer restored it, deleted it again, or the Trash purged it).
   */
  gone: TreeReceipt[];
  /** The lists that hold the steps' nodes, to be locked before any document key. */
  lists: TreeList[];
  /** The Works whose branches a drafted step writes. */
  branches: BranchId[];
  /** The steps' documents, each where it is reversed, for the edit grants (a restore is its own). */
  documents: { documentId: string; branchId: BranchId | null; restore: boolean }[];
  /**
   * Documents whose create this Undo takes back in live: text an Apply wrote there has no
   * inverse of its own and leaves with the document.
   */
  leavingLive: string[];
};

export const NO_TREE_STEPS: TreePlan = {
  steps: [],
  gone: [],
  lists: [],
  branches: [],
  documents: [],
  leavingLive: [],
};

export type TurnTreeInverse = ReturnType<typeof createTurnTreeInverse>;

export function createTurnTreeInverse(deps: {
  db: Database;
  treeLists: Pick<TreeListStore, "read" | "submit">;
  history: () => Pick<AgentTreeHistory, "turnSteps" | "recordAgentTreeChange">;
}) {
  const db = () => currentDrizzleDb(deps.db);

  /** The other list of a move between a project's files and the account's: the thread's project, or its owner. */
  async function otherList(threadId: ThreadId, list: TreeList): Promise<TreeList | null> {
    const [row] = await db()
      .select({ projectId: projects.id, userId: projects.userId })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .where(eq(threads.id, threadId));
    if (!row) return null;
    return list.kind === "project"
      ? { kind: "account", userId: row.userId }
      : { kind: "project", projectId: row.projectId };
  }

  /**
   * What became of each node's tree change the turn drafted, read from its records in the list
   * that holds the node: `pending` while one still waits in its Work, else `applied` when an Apply
   * took one, else `discarded` (a Discard took them, or the Work's purge did).
   */
  async function draftStates(
    threadId: ThreadId,
    turnId: TurnId,
  ): Promise<Record<string, TurnDraftState>> {
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
    const byList = new Map<
      string,
      { list: TreeList; records: { record: string; node: string }[] }
    >();
    for (const entry of receipts.flatMap((receipt) => receipt.records)) {
      const list = await treeListOfNode(deps.db, entry.node);
      if (!list) continue;
      const key = JSON.stringify(list);
      const known = byList.get(key) ?? { list, records: [] };
      known.records.push(entry);
      byList.set(key, known);
    }
    const states: Record<string, TurnDraftState> = {};
    const rank = { discarded: 0, applied: 1, pending: 2 } as const;
    for (const { list, records } of byList.values()) {
      const read = await deps.treeLists.read({
        lists: [list],
        view: ([end]) => {
          if (!end) return [];
          const present = new Set(listRecords(end.writer.doc).map((record) => record.id));
          const last = lastSettlements(end.writer.doc);
          return records.map(({ record, node }) => {
            const to = present.has(record) ? (last.get(record)?.to ?? null) : "discarded";
            const state: TurnDraftState =
              to === null
                ? "pending"
                : to === "applied" || to === "superseded"
                  ? "applied"
                  : "discarded";
            return [node, state] as const;
          });
        },
      });
      for (const [node, state] of read) {
        const was = states[node];
        if (!was || rank[state] > rank[was]) states[node] = state;
      }
    }
    return states;
  }

  async function plan(
    threadId: ThreadId,
    turnId: TurnId,
    direction: "undo" | "redo",
  ): Promise<TreePlan> {
    const all = await deps.history().turnSteps(threadId, turnId, direction);
    if (all.length === 0) return NO_TREE_STEPS;
    // A drafted Undo is applicable while its branch still places the node; once a Discard took it
    // out there is no file to ask a grant about and nothing to reverse. A Redo's node is out of
    // the branch (its Undo took it), and a Discard shows there as a record that no longer
    // reverses. Every other denial of a step's document refuses the reversal.
    const held = new Set<string>();
    const draftedIn = new Map<string, string[]>();
    for (const step of all)
      if (step.draftBranchId && direction === "undo")
        draftedIn.set(step.draftBranchId, [
          ...(draftedIn.get(step.draftBranchId) ?? []),
          step.subject,
        ]);
    for (const [branchId, ids] of draftedIn)
      for (const row of await db().execute<{ id: string }>(sql`
        SELECT n.id::text AS id FROM ${placedNodesSql({ kind: "branch", branchId: branchId as BranchId })} n
        WHERE n.id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`))
        held.add(`${branchId}:${row.id}`);
    const ids = all.map((step) => step.subject);
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
    // What the reversal does to the node: bring it back, or take it away.
    const restores = (step: TreeReceipt) =>
      direction === "undo" ? step.op === "delete" : step.op === "create" || step.op === "restore";
    // A restore in live acts only through deletes that still hold its nodes in Trash: the
    // writer's restore or later delete, or a purge, leaves a delete nothing to take back.
    const standing = new Set<string>();
    const byList = new Map<string, { list: TreeList; records: string[] }>();
    for (const step of all) {
      if (step.draftBranchId || !restores(step)) continue;
      const list = await treeListOfNode(deps.db, step.subject);
      if (!list) continue;
      const key = JSON.stringify(list);
      const entry = byList.get(key) ?? { list, records: [] };
      entry.records.push(...step.records.map((record) => record.record));
      byList.set(key, entry);
    }
    for (const { list, records } of byList.values())
      for (const record of await deps.treeLists.read({
        lists: [list],
        view: ([end]) => records.filter((id) => end && deleteStands(end.writer, LIVE, id)),
      }))
        standing.add(record);
    const restoresNode = (step: TreeReceipt, node: string) =>
      step.records.some((entry) => entry.node === node && standing.has(entry.record));
    const acts = (step: TreeReceipt) => {
      if (step.draftBranchId)
        return direction === "redo" || held.has(`${step.draftBranchId}:${step.subject}`);
      return !restores(step) || step.records.some((entry) => standing.has(entry.record));
    };
    const gone = all.filter((step) => !acts(step));
    const steps = all.filter((step) => !gone.includes(step));
    const lists = new Map<string, TreeList>();
    for (const step of steps) {
      const list = await treeListOfNode(deps.db, step.subject);
      if (!list) continue;
      lists.set(JSON.stringify(list), list);
      const other = step.across ? await otherList(threadId, list) : null;
      if (other) lists.set(JSON.stringify(other), other);
    }
    return {
      steps,
      gone,
      lists: [...lists.values()],
      branches: [
        ...new Set(steps.flatMap((step) => (step.draftBranchId ? [step.draftBranchId] : []))),
      ] as BranchId[],
      documents: steps.flatMap((step) => {
        const restore = restores(step);
        // A document in Trash takes no edit grant but its own restore: a step that finds it
        // changed since is skipped.
        const placed = live.has(step.subject) && live.get(step.subject) === null;
        return subjects.has(step.subject) &&
          (step.draftBranchId || (restore ? restoresNode(step, step.subject) : placed))
          ? [
              {
                documentId: step.subject,
                branchId: step.draftBranchId as BranchId | null,
                restore,
              },
            ]
          : [];
      }),
      leavingLive: steps.flatMap((step) =>
        direction === "undo" &&
        step.op === "create" &&
        subjects.has(step.subject) &&
        live.has(step.subject) &&
        live.get(step.subject) === null
          ? [step.subject]
          : [],
      ),
    };
  }

  /**
   * Takes the receipts back in the order given (the caller holds the lists' keys, the Works and
   * the documents). A receipt something later changed (`superseded`) is skipped, and a partly
   * superseded one reports as skipped too; the rest is reversed. Returns how many receipts
   * reversed something. The receipts one list holds go back in one update of it: every browser
   * showing the list redraws its tree once for the whole Undo, not once a receipt.
   */
  async function run(
    plan: Pick<TreePlan, "steps" | "gone">,
    direction: "undo" | "redo",
    input: {
      threadId: ThreadId;
      userId: UserId | undefined;
      moveBackAcrossLists?: MoveBackAcrossLists;
    },
  ): Promise<{ reversed: number; skips: TurnInverseSkip[] }> {
    const actor = input.userId ? `user:${input.userId}` : "system";
    const skips: TurnInverseSkip[] = [];
    let reversed = 0;
    const skip = (receipt: TreeReceipt, cause: "superseded" | "refused"): TurnInverseSkip => ({
      kind: "tree",
      documentId: receipt.subject,
      uri: receipt.shownAt ?? receipt.subject,
      at: receipt.shownAt,
      cause,
    });
    const record = (
      receipt: TreeReceipt,
      fields: Pick<TreeReceiptInput, "nodes" | "records"> &
        Partial<Pick<TreeReceiptInput, "acrossLists" | "draftBranchId">>,
    ) =>
      deps.history().recordAgentTreeChange({
        subject: receipt.subject,
        op: receipt.op,
        threadId: input.threadId,
        ...(receipt.turnId ? { turnId: receipt.turnId as TurnId } : {}),
        shownAt: receipt.shownAt ?? "",
        reverses: { kind: direction, receipt: receipt.id },
        ...fields,
      });

    for (const receipt of plan.gone) skips.push(skip(receipt, "superseded"));

    // Consecutive receipts in one list, taken back together.
    let batch: { list: TreeList; receipts: TreeReceipt[] } | null = null;
    const flush = async () => {
      if (!batch) return;
      const { list, receipts } = batch;
      batch = null;
      const { result } = await deps.treeLists.submit({
        lists: [list],
        make: ([{ writer }]) =>
          receipts.map((receipt) => {
            const view: View = receipt.draftBranchId ? { draft: receipt.draftBranchId } : LIVE;
            const made: { record: string; node: string }[] = [];
            let failed = 0;
            let inLive = receipt.draftBranchId === null;
            for (const entry of [...receipt.records].reverse()) {
              const back = undoChange(writer, view, actor, entry.record);
              if (typeof back === "string") failed++;
              else {
                if (back.draft === null) inLive = true;
                made.push({ record: back.id, node: entry.node });
              }
            }
            return { receipt, made, failed, inLive };
          }),
      });
      for (const { receipt, made, failed, inLive } of result) {
        if (failed > 0) skips.push(skip(receipt, "superseded"));
        if (made.length === 0) continue;
        reversed++;
        await record(receipt, {
          nodes: receipt.nodes.map((nodeId) => ({ nodeId, beforeAt: null, afterAt: null })),
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
        skips.push(skip(receipt, "superseded"));
        continue;
      }
      if (!receipt.across) {
        if (batch && JSON.stringify(batch.list) === JSON.stringify(list))
          batch.receipts.push(receipt);
        else {
          await flush();
          batch = { list, receipts: [receipt] };
        }
        continue;
      }
      // A move between lists writes both: what came before it in the order goes first.
      await flush();
      const answer = input.moveBackAcrossLists
        ? await input.moveBackAcrossLists(receipt)
        : ({ ok: false, cause: "refused" } as const);
      if (!answer.ok) {
        skips.push(skip(receipt, answer.cause));
        continue;
      }
      reversed++;
      await record(receipt, {
        nodes: [
          { nodeId: receipt.subject, beforeAt: receipt.across.to, afterAt: receipt.across.from },
        ],
        records: [
          { record: answer.records.left, node: receipt.subject },
          { record: answer.records.entered, node: receipt.subject },
        ],
        acrossLists: true,
      });
    }
    await flush();
    return { reversed, skips };
  }

  return { plan, run, draftStates };
}
