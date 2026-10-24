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
import { allocateContextEntryArrivalName, type ContextEntrySibling } from "../context-entry-name";
import { placeEntry } from "../move-entry";
import { renameOperationLifecycle } from "../rename-operation-lifecycle";
import type { EntryRef } from "./entry";
import { type MoveEffect, planUndo, type ReadyMovePlan, sameParent } from "./move-plan";

export type MoveContext = {
  resources: AccountResourceReplica;
  projectId: string;
  /** The rows a parent holds now, so an arrival predicts the next free name. */
  siblingsAt: (parent: ParentRef) => readonly ContextEntrySibling[];
};

export type MoveResult = {
  moved: readonly MoveEffect[];
  /** Rows the replica would not admit. */
  failed: readonly { entry: EntryRef; name: string }[];
};

type Arrival = {
  entry: EntryRef;
  name: string;
  /** The name the writer asked for (a Move… retry keeps a refused rename); the row's own otherwise. */
  typed?: string;
  after: ParentRef;
};

type MoveRow = Arrival & { before: ParentRef };

/**
 * The free name each row would arrive under. Each row also sees the rows
 * before it in the same move, which the catalogs do not show yet, so two
 * `Notes` folders become `Notes (2)` and `Notes (3)`. The hover warning and the
 * placement read the same prediction.
 */
export function arrivalNames(
  rows: readonly Arrival[],
  siblingsAt: MoveContext["siblingsAt"],
): string[] {
  const names: string[] = [];
  rows.forEach((row, index) => {
    const arrived = rows.slice(0, index).flatMap((earlier, at): ContextEntrySibling[] =>
      sameParent(earlier.after, row.after)
        ? [
            {
              entryId: earlier.entry.id,
              name: names[at] ?? earlier.name,
              kind: earlier.entry.kind === "file" ? "file" : "dir",
            },
          ]
        : [],
    );
    names.push(
      allocateContextEntryArrivalName(
        row.typed ?? row.name,
        [...siblingsAt(row.after), ...arrived],
        row.entry.kind,
        row.name,
      ),
    );
  });
  return names;
}

/** The rows a move would rename on arrival, for the warning shown before it happens. */
export function renamesOnArrival(
  rows: readonly Arrival[],
  siblingsAt: MoveContext["siblingsAt"],
): { name: string; as: string }[] {
  const names = arrivalNames(rows, siblingsAt);
  return rows.flatMap((row, index) => {
    const as = names[index];
    return as && as !== (row.typed ?? row.name) ? [{ name: row.name, as }] : [];
  });
}

/** Move…, a drop and Undo all move rows here, each under its predicted free name. */
export async function moveRows(
  rows: readonly MoveRow[],
  context: MoveContext,
): Promise<MoveResult> {
  const { resources, projectId } = context;
  const names = arrivalNames(rows, context.siblingsAt);
  const moved: MoveEffect[] = [];
  const failed: { entry: EntryRef; name: string }[] = [];
  for (const [index, row] of rows.entries()) {
    const name = names[index] ?? row.name;
    try {
      const operationId = await placeEntry(
        resources,
        projectId,
        row.entry,
        { parent: row.after, name },
        row.typed ?? row.name,
      );
      if (operationId)
        void renameOperationLifecycle(resources).remember(projectId, row.entry, operationId);
      moved.push({
        entry: row.entry,
        name,
        previousName: row.name,
        before: row.before,
        after: row.after,
      });
    } catch {
      failed.push({ entry: row.entry, name: row.name });
    }
  }
  return { moved, failed };
}

/** `after` is the destination's parent, null when its authority is unavailable (every row then fails). */
export function executeMove(
  plan: ReadyMovePlan,
  after: ParentRef | null,
  context: MoveContext,
): Promise<MoveResult> {
  const rows = plan.moves.map(({ ref, name, parent }) => ({ entry: ref, name, before: parent }));
  return after
    ? moveRows(
        rows.map((row) => ({ ...row, after })),
        context,
      )
    : Promise.resolve({ moved: [], failed: rows.map(({ entry, name }) => ({ entry, name })) });
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
  return moveRows(planUndo(view, effects), context);
}
