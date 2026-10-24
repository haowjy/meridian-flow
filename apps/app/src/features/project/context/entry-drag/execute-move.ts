/**
 * Doing and undoing a planned move through the replica's one placement path.
 * Placement is optimistic: a move resolves once the replica admits it, and a
 * later server refusal lands on the row as its failure mark with Move… to
 * repair. Each placement's operation is remembered so the row's link-update
 * note follows its receipt. Arrival names are predicted from the replica's
 * placement, so a move or its Undo needs no list on screen. Results are data;
 * wording, selection and the notice belong to the caller.
 */

import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import {
  type ParentRef,
  type ResourcePlacement,
  type ResourceRecord,
  resourcePlacementForSnapshot,
} from "@meridian/resource-replica";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import {
  allocateContextEntryArrivalName,
  type NameOccupancy,
  nameOccupancy,
} from "../context-entry-name";
import { placeEntry } from "../move-entry";
import { renameOperationLifecycle } from "../rename-operation-lifecycle";
import type { EntryRef } from "./entry";
import { type MoveEffect, planUndo, type ReadyMovePlan } from "./move-plan";

export type MoveContext = {
  resources: AccountResourceReplica;
  projectId: string;
};

/** The replica's placement, which names what every parent holds; no list needs to be on screen. */
export type NamingView = {
  records: readonly ResourceRecord[];
  placement: Pick<ResourcePlacement, "childrenAt">;
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
 * Free names for the rows of one move. Each destination's names are indexed
 * once; a row's name is reserved once it arrives, so the next row sees it
 * though the replica has not caught up (two `Notes` folders become
 * `Notes (2)` and `Notes (3)`), and a row that fails reserves nothing.
 */
function arrivals(view: NamingView) {
  const byParent = new Map<string, NameOccupancy>();
  const occupancy = (parent: ParentRef) => {
    const key = parentKey(parent);
    let occupied = byParent.get(key);
    if (!occupied) {
      occupied = nameOccupancy(
        view.placement.childrenAt(parent, view.records).map((row) => ({
          entryId: row.entryId,
          name: row.name,
          kind: row.kind === "folder" ? "dir" : "file",
        })),
      );
      byParent.set(key, occupied);
    }
    return occupied;
  };
  return {
    name: (row: Arrival) =>
      allocateContextEntryArrivalName(
        row.typed ?? row.name,
        occupancy(row.after),
        row.entry.kind,
        row.name,
      ),
    reserve: (row: Arrival, name: string) =>
      occupancy(row.after).claim({
        kind: row.entry.kind === "folder" ? "folder" : "document",
        filename: name,
      }),
  };
}

/** One key per parent `sameParent` treats as equal. */
function parentKey(parent: ParentRef): string {
  if (parent.kind === "folder") return `folder:${parent.folderId}`;
  if (isProjectScopedScheme(parent.scheme)) return `root:${parent.scheme}`;
  return `root:${parent.scheme}:${parent.owner.workId ?? ""}:${parent.owner.rootThreadId ?? ""}`;
}

/**
 * The rows a move would rename on arrival, for the warning shown before it
 * happens. It predicts exactly as `moveRows` places, as if every row arrives.
 */
export function renamesOnArrival(
  rows: readonly Arrival[],
  view: NamingView,
): { name: string; as: string }[] {
  const names = arrivals(view);
  return rows.flatMap((row) => {
    const as = names.name(row);
    names.reserve(row, as);
    return as !== (row.typed ?? row.name) ? [{ name: row.name, as }] : [];
  });
}

async function currentView(context: MoveContext) {
  const snapshot = await context.resources.readProjection(context.projectId);
  return {
    records: snapshot.records,
    placement: resourcePlacementForSnapshot(context.projectId, snapshot),
  };
}

/** Move…, a drop and Undo all move rows here, each under its predicted free name. */
export async function moveRows(
  rows: readonly MoveRow[],
  context: MoveContext,
  view?: NamingView,
): Promise<MoveResult> {
  const { resources, projectId } = context;
  const names = arrivals(view ?? (await currentView(context)));
  const moved: MoveEffect[] = [];
  const failed: { entry: EntryRef; name: string }[] = [];
  for (const row of rows) {
    const name = names.name(row);
    try {
      const operationId = await placeEntry(
        resources,
        projectId,
        row.entry,
        { parent: row.after, name },
        row.typed ?? row.name,
      );
      names.reserve(row, name);
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
  const view = await currentView(context);
  return moveRows(planUndo(view, effects), context, view);
}
