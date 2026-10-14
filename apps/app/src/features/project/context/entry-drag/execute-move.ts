/**
 * Doing and undoing a planned move through the replica's one placement path.
 * Placement is optimistic: a move resolves once the replica admits it, and a
 * later server refusal lands on the row as its failure mark with Move… to
 * repair. Each placement's operation is remembered so the row's link-update
 * note follows its receipt. Results are data; wording, selection and the
 * notice belong to the caller.
 */
import { type ParentRef, resourcePlacementForSnapshot } from "@meridian/resource-replica";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { destinationParent, placeEntry } from "../move-entry";
import { renameOperationLifecycle } from "../rename-operation-lifecycle";
import type { EntryRef } from "./entry";
import { type MoveEffect, planUndo, type ReadyMovePlan } from "./move-plan";

type MoveContext = {
  resources: AccountResourceReplica;
  projectId: string;
  works: Parameters<typeof destinationParent>[1];
  noWork: Parameters<typeof destinationParent>[2];
};

export type MoveResult = {
  moved: readonly MoveEffect[];
  /** Rows the replica would not admit. */
  failed: readonly { entry: EntryRef; name: string }[];
};

async function place(
  { resources, projectId }: MoveContext,
  entry: EntryRef,
  name: string,
  parent: ParentRef,
): Promise<string | null> {
  const operationId = await placeEntry(resources, projectId, entry, { parent, name });
  if (operationId) void renameOperationLifecycle(resources).remember(projectId, entry, operationId);
  return operationId;
}

async function settle(
  rows: readonly { entry: EntryRef; name: string; before: ParentRef; after: ParentRef }[],
  context: MoveContext,
): Promise<MoveResult> {
  const results = await Promise.allSettled(
    rows.map((row) => place(context, row.entry, row.name, row.after)),
  );
  const moved: MoveEffect[] = [];
  const failed: { entry: EntryRef; name: string }[] = [];
  rows.forEach((row, index) => {
    const result = results[index];
    if (result?.status === "fulfilled") moved.push({ ...row, operationId: result.value });
    else failed.push({ entry: row.entry, name: row.name });
  });
  return { moved, failed };
}

export function executeMove(plan: ReadyMovePlan, context: MoveContext): Promise<MoveResult> {
  const after = destinationParent(plan.destination, context.works, context.noWork);
  return after
    ? settle(
        plan.moves.map((move) => ({
          entry: move.ref,
          name: move.name,
          before: move.before,
          after,
        })),
        context,
      )
    : Promise.resolve({
        moved: [],
        failed: plan.moves.map((move) => ({ entry: move.ref, name: move.name })),
      });
}

/**
 * Puts moved rows back, reading the replica as it is now rather than as it was
 * at the drop (see `planUndo`).
 */
export async function undoMove(
  effects: readonly MoveEffect[],
  context: MoveContext,
): Promise<MoveResult> {
  const snapshot = await context.resources.readProjection(context.projectId);
  const view = {
    records: snapshot.records,
    placement: resourcePlacementForSnapshot(context.projectId, snapshot),
  };
  return settle(planUndo(view, effects), context);
}
