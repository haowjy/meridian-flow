/**
 * Doing and undoing a planned move through the replica's one placement path.
 * Placement is optimistic: a move resolves once the replica admits it, and a
 * later server refusal lands on the row as its failure mark with Move… to
 * repair. Each placement's operation is remembered so the row's link-update
 * note follows its receipt. Arrival names are predicted from the replica's
 * placement, so a move or its Undo needs no list on screen. Results are data;
 * wording, selection and the notice belong to the caller.
 */

import {
  type ParentRef,
  placementParentKey,
  type ResourceDestination,
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
import { renameOperationLifecycle } from "../rename-operation-lifecycle";
import type { EntryRef } from "./entry";
import {
  type MoveEffect,
  type MoveRow,
  planUndo,
  sameParent,
  siblingPositionWitness,
} from "./move-plan";

export type MoveContext = {
  resources: AccountResourceReplica;
  projectId: string;
};

/** The replica's placement, which names what every parent holds; no list needs to be on screen. */
export type NamingView = {
  records: readonly ResourceRecord[];
  folders?: Awaited<ReturnType<AccountResourceReplica["readProjection"]>>["folders"];
  placement: Pick<ResourcePlacement, "childrenAt">;
};

export type MoveResult = {
  moved: readonly MoveEffect[];
  /** Rows the replica would not admit. */
  failed: readonly { entry: EntryRef; name: string; action: "move" | "reorder" }[];
};

export type Arrival = {
  entry: EntryRef;
  name: string;
  /** The name the writer asked for (a Move… retry keeps a refused rename); the row's own otherwise. */
  typed?: string;
  before?: ParentRef;
  after: ParentRef;
};

/** Places one row under the name predicted by this module. */
async function placeEntry(
  resources: AccountResourceReplica,
  projectId: string,
  subject: EntryRef,
  location: ResourceDestination,
  typed: string,
): Promise<string | null> {
  if (subject.kind === "folder") {
    const result = await resources.setFolderLocation(projectId, subject.id, location, typed);
    return result.operationId ?? null;
  }
  const key = await resources.keyForDocument(projectId, subject.id);
  if (!key) throw new Error("Document is not in the replica");
  const result = await resources.setLocation(projectId, key, location, typed);
  return result.operationId ?? null;
}

/**
 * Free names for the rows of one move. Each destination's names are indexed
 * once; a row's name is reserved once it arrives, so the next row sees it
 * though the replica has not caught up (two `Notes` folders become
 * `Notes (2)` and `Notes (3)`), and a row that fails reserves nothing.
 */
export function arrivals(view: NamingView, rows: readonly Arrival[]) {
  const byParent = new Map<string, NameOccupancy>();
  const staying = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.before || !sameParent(row.before, row.after)) continue;
    const key = placementParentKey(row.after);
    const entries = staying.get(key) ?? new Set<string>();
    entries.add(row.entry.id);
    staying.set(key, entries);
  }
  const occupancy = (parent: ParentRef) => {
    const key = placementParentKey(parent);
    let occupied = byParent.get(key);
    if (!occupied) {
      occupied = nameOccupancy(
        view.placement.childrenAt(parent, view.records).flatMap((row) =>
          staying.get(key)?.has(row.entryId)
            ? []
            : [
                {
                  entryId: row.entryId,
                  name: row.name,
                  kind: row.kind === "folder" ? ("dir" as const) : ("file" as const),
                },
              ],
        ),
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

/**
 * The rows a move would rename on arrival, for the warning shown before it
 * happens. It predicts exactly as `moveRows` places, as if every row arrives.
 */
export function renamesOnArrival(
  rows: readonly Arrival[],
  view: NamingView,
): { name: string; as: string }[] {
  const names = arrivals(view, rows);
  return rows.flatMap((row) => {
    const as = names.name(row);
    names.reserve(row, as);
    return as !== (row.typed ?? row.name) ? [{ name: row.name, as }] : [];
  });
}

export async function currentView(context: MoveContext) {
  const snapshot = await context.resources.readProjection(context.projectId);
  return {
    records: snapshot.records,
    folders: snapshot.folders,
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
  const current = view ?? (await currentView(context));
  const names = arrivals(current, rows);
  const moved: MoveEffect[] = [];
  const failed: { entry: EntryRef; name: string; action: "move" | "reorder" }[] = [];
  for (const row of rows) {
    const name = names.name(row);
    const action = sameParent(row.before, row.after) && row.position ? "reorder" : "move";
    const previousPosition = siblingPositionWitness(current, row.before, row.entry.id);
    try {
      const operationId = await placeEntry(
        resources,
        projectId,
        row.entry,
        { parent: row.after, name, ...(row.position ? { position: row.position } : {}) },
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
        previousPosition,
        action,
        ...(operationId ? { operationId } : {}),
      });
    } catch {
      failed.push({ entry: row.entry, name: row.name, action });
    }
  }
  return { moved, failed };
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
