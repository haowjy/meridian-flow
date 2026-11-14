/**
 * The tree half of a card's Undo or Redo of a reply: the reply's tree receipts (the model's
 * moves, renames, deletes and creates), taken back by the package's `undoChange` in the list
 * that holds each node, as one step of the card's command. The receipts are the history the
 * model's own `undo` chooses from (`tree_edit_receipts` and their `reverses` links), and each
 * reversal is recorded as a receipt in turn, so the model's `undo` and the card's see one order.
 */

import type { BranchId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type { TurnInverseSkip } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, treeNodes } from "@meridian/database/schema";
import { LIVE, undoChange, type View } from "@meridian/project-tree";
import { and, inArray, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { AgentTreeHistory, TreeReceipt } from "../contracts.js";
import { treeListOfNode } from "./drizzle-branch-tree-lists.js";

/** What a reversal needs from the locks' step: which lists, Works and documents it will touch. */
export type TreePlan = {
  steps: TreeReceipt[];
  /** The lists that hold the steps' nodes, to be locked before any document key. */
  lists: TreeList[];
  /** The Works whose branches a drafted step writes. */
  branches: BranchId[];
  /** The steps' documents, each where it is reversed, for the edit grants (a restore is its own). */
  documents: { documentId: string; branchId: BranchId | null; restore: boolean }[];
};

export const NO_TREE_STEPS: TreePlan = { steps: [], lists: [], branches: [], documents: [] };

export type TurnTreeInverse = ReturnType<typeof createTurnTreeInverse>;

export function createTurnTreeInverse(deps: {
  db: Database;
  treeLists: Pick<TreeListStore, "submit">;
  history: () => Pick<AgentTreeHistory, "turnSteps" | "recordAgentTreeChange">;
}) {
  const db = () => currentDrizzleDb(deps.db);

  async function plan(
    threadId: ThreadId,
    turnId: TurnId,
    direction: "undo" | "redo",
  ): Promise<TreePlan> {
    const steps = await deps.history().turnSteps(threadId, turnId, direction);
    if (steps.length === 0) return NO_TREE_STEPS;
    const lists = new Map<string, TreeList>();
    for (const step of steps) {
      const list = await treeListOfNode(deps.db, step.subject);
      if (list) lists.set(JSON.stringify(list), list);
    }
    const ids = steps.map((step) => step.subject);
    const subjects = new Set(
      (
        await db().select({ id: documents.id }).from(documents).where(inArray(documents.id, ids))
      ).map((row) => row.id as string),
    );
    // A document in Trash takes no edit grant, but a restore: a step that finds it changed
    // since is skipped on its own, not a denial of the whole reversal.
    const standing = new Set(
      (
        await db()
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .where(and(inArray(treeNodes.id, ids), isNull(treeNodes.trashRecord)))
      ).map((row) => row.id as string),
    );
    return {
      steps,
      lists: [...lists.values()],
      branches: [
        ...new Set(steps.flatMap((step) => (step.draftBranchId ? [step.draftBranchId] : []))),
      ] as BranchId[],
      documents: steps.flatMap((step) => {
        // What the reversal does to the node: bring it back, or take it away.
        const restore =
          direction === "undo"
            ? step.op === "delete"
            : step.op === "create" || step.op === "restore";
        const drafted = step.draftBranchId !== null;
        return subjects.has(step.subject) && (drafted || restore || standing.has(step.subject))
          ? [{ documentId: step.subject, branchId: step.draftBranchId as BranchId | null, restore }]
          : [];
      }),
    };
  }

  /**
   * Takes the receipts back in the order given (the caller holds the lists' keys, the Works and
   * the documents). A receipt something later changed (`superseded`) is skipped, and a partly
   * superseded one reports as skipped too; the rest is reversed. Returns how many receipts
   * reversed something.
   */
  async function run(
    steps: readonly TreeReceipt[],
    direction: "undo" | "redo",
    input: { threadId: ThreadId; userId: UserId | undefined },
  ): Promise<{ reversed: number; skips: TurnInverseSkip[] }> {
    const actor = input.userId ? `user:${input.userId}` : "system";
    const skips: TurnInverseSkip[] = [];
    let reversed = 0;
    for (const receipt of steps) {
      const skip = (cause: "superseded" | "refused"): TurnInverseSkip => ({
        kind: "tree",
        documentId: receipt.subject,
        uri: receipt.shownAt ?? receipt.subject,
        at: receipt.shownAt,
        cause,
      });
      // A move between a project's list and the account's is taken back by the model's tools,
      // which name both ends; the card leaves it.
      const list = receipt.across ? null : await treeListOfNode(deps.db, receipt.subject);
      if (!list) {
        skips.push(skip(receipt.across ? "refused" : "superseded"));
        continue;
      }
      const view: View = receipt.draftBranchId ? { draft: receipt.draftBranchId } : LIVE;
      const made: { record: string; node: string }[] = [];
      let failed = 0;
      let inLive = receipt.draftBranchId === null;
      await deps.treeLists.submit({
        lists: [list],
        make: ([{ writer }]) => {
          for (const entry of [...receipt.records].reverse()) {
            let back = undoChange(writer, view, actor, entry.record);
            // A drafted change an Apply landed is taken back in live: the Work's draft lacks it.
            if (typeof back === "string" && receipt.draftBranchId !== null) {
              back = undoChange(writer, LIVE, actor, entry.record);
              if (typeof back !== "string") inLive = true;
            }
            if (typeof back === "string") failed++;
            else made.push({ record: back.id, node: entry.node });
          }
        },
      });
      if (failed > 0) skips.push(skip("superseded"));
      if (made.length === 0) continue;
      reversed++;
      await deps.history().recordAgentTreeChange({
        subject: receipt.subject,
        nodes: receipt.nodes.map((nodeId) => ({ nodeId, beforeAt: null, afterAt: null })),
        records: made,
        op: receipt.op,
        threadId: input.threadId,
        ...(receipt.turnId ? { turnId: receipt.turnId as TurnId } : {}),
        ...(receipt.draftBranchId && !inLive
          ? { draftBranchId: receipt.draftBranchId as BranchId }
          : {}),
        shownAt: receipt.shownAt ?? "",
        reverses: { kind: direction, receipt: receipt.id },
      });
    }
    return { reversed, skips };
  }

  return { plan, run };
}
