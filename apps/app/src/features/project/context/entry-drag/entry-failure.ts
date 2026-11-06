/**
 * The one way a tree Move, Copy or delete runs and fails. Each `run…` does the work and owns its
 * failure toast and that toast's Retry, and a Retry re-reads the replica when pressed: a row the
 * writer has changed since is left alone. `entryRefusals` reads the rows the server refused for
 * `RefusalToasts`, and `retryRefusals` retries them by intent, so a server refusal and one the
 * replica made at once retry through the same paths.
 */
import { plural, t } from "@lingui/core/macro";
import {
  type ParentRef,
  placementParentKey,
  projectFolderNeedsRepair,
  projectResourceNeedsRepair,
  type ResourceDestination,
} from "@meridian/resource-replica";
import { refusedMoveDestination } from "@/client/query/context-catalog-projection";
import { getContextTabs } from "@/client/stores";
import { notifyFailure } from "@/components/app/failure-toast";
import { useDockDocumentStore } from "../../dock/dock-document-store";
import { schemeLabel } from "../context-schemes";
import type { RemovedNoticeStore } from "../removed-notice-store";
import { copyRefusals } from "./copy-refusal";
import type { EntryRef } from "./entry";
import { copyRows } from "./execute-copy";
import { currentView, moveRows, type ReplicaContext } from "./execute-move";
import {
  entryNameNow,
  type MoveRow,
  type PlacementView,
  parentOf,
  type ReadyCopy,
  sameParent,
  within,
} from "./move-plan";

/** The toast key of a failed Move or delete, and of a Copy the replica would not admit. */
export const ENTRY_FAILURE_TOAST = "entry-failure";

export type EntryContext = ReplicaContext & {
  notices?: Pick<RemovedNoticeStore, "markOwnRemoval"> | null;
};

type Named = { name: string };

function moveFailure(rows: readonly Named[], destination: string | null): string {
  const [only] = rows;
  if (rows.length === 1 && only)
    return destination
      ? t`Couldn't move ${only.name} to ${destination}.`
      : t`Couldn't move ${only.name}.`;
  return destination
    ? plural(rows.length, {
        one: `Couldn't move # item to ${destination}.`,
        other: `Couldn't move # items to ${destination}.`,
      })
    : plural(rows.length, { one: "Couldn't move # item.", other: "Couldn't move # items." });
}

function deleteFailure(rows: readonly Named[]): string {
  const [only] = rows;
  return rows.length === 1 && only
    ? t`Couldn't delete ${only.name}.`
    : plural(rows.length, { one: "Couldn't delete # item.", other: "Couldn't delete # items." });
}

/** The rows still as they were when the Move failed. */
async function unchangedRows(context: ReplicaContext, rows: readonly MoveRow[]) {
  const view = await currentView(context);
  return rows.filter((row) => {
    const parent = parentOf(view, row.entry);
    return (
      entryNameNow(view, row.entry) === row.name &&
      parent !== null &&
      sameParent(parent, row.before)
    );
  });
}

export async function runMove(
  context: EntryContext,
  rows: readonly MoveRow[],
  destination: string | null,
  onMoved?: (moved: readonly EntryRef[]) => void,
): Promise<void> {
  const { moved, failed } = await moveRows(rows, context);
  onMoved?.(moved);
  if (failed.length === 0) return;
  const refused = new Set(failed.map(({ entry }) => entry));
  const again = rows.filter(({ entry }) => refused.has(entry));
  notifyFailure({
    key: ENTRY_FAILURE_TOAST,
    title: moveFailure(again, destination),
    onRetry: async () =>
      runMove(context, await unchangedRows(context, again), destination, onMoved),
  });
}

export async function runCopy(
  context: EntryContext,
  copy: ReadyCopy,
  onCopied?: (copies: readonly EntryRef[]) => void,
): Promise<void> {
  const rows = await copyRows(copy, context);
  if (rows) {
    onCopied?.(rows);
    return;
  }
  const [only] = copy.copies;
  notifyFailure({
    key: ENTRY_FAILURE_TOAST,
    title:
      copy.copies.length === 1 && only
        ? t`Couldn't copy ${only.name} to ${copy.destinationName}.`
        : plural(copy.copies.length, {
            one: `Couldn't copy # item to ${copy.destinationName}.`,
            other: `Couldn't copy # items to ${copy.destinationName}.`,
          }),
    onRetry: async () => {
      const view = await currentView(context);
      const copies = copy.copies.flatMap((row) => {
        const name = entryNameNow(view, row.entry);
        return name ? [{ ...row, name }] : [];
      });
      if (copies.length > 0) await runCopy(context, { ...copy, copies }, onCopied);
    },
  });
}

/** The documents on the writer's own tabs and dock that deleting `entry` takes away. */
async function ownRemovals(context: EntryContext, entry: EntryRef): Promise<string[]> {
  if (entry.kind === "file") return [entry.id];
  const { projectId } = context;
  const view = await currentView(context);
  const dock = useDockDocumentStore.getState().occupant;
  const presented = [
    ...getContextTabs(projectId).tabs,
    ...(dock?.projectId === projectId ? [dock.tab] : []),
  ];
  return presented.flatMap((tab) =>
    tab.kind !== "new" &&
    within(view, parentOf(view, { kind: "file", id: tab.documentId }), entry.id)
      ? [tab.documentId]
      : [],
  );
}

export async function runDelete(
  { name, ...entry }: EntryRef & Named,
  context: EntryContext,
): Promise<void> {
  const { resources, projectId, notices } = context;
  const settleMark = notices?.markOwnRemoval(projectId, await ownRemovals(context, entry));
  try {
    if (entry.kind === "folder") await resources.deleteFolder(projectId, entry.id);
    else {
      const key = await resources.keyForDocument(projectId, entry.id);
      if (!key) throw new Error("Document resource is unavailable");
      await resources.deleteDocument(projectId, key);
    }
    settleMark?.("removed");
  } catch {
    settleMark?.("kept");
    notifyFailure({
      key: ENTRY_FAILURE_TOAST,
      title: deleteFailure([{ name }]),
      onRetry: () => runDelete({ name, ...entry }, context),
    });
  }
}

/** One row the server refused, as it can be retried now. */
export type EntryRefusal = {
  intentId: string;
  /** Rows refused together share a toast: every delete, or every Move to one place. */
  group: string;
  title: (rows: readonly EntryRefusal[]) => string;
} & (
  | { kind: "delete"; entry: EntryRef; name: string }
  | { kind: "move"; row: MoveRow; name: string; destination: string | null }
);

const placeName = (view: PlacementView, { parent }: ResourceDestination) =>
  parent.kind === "root"
    ? schemeLabel(parent.scheme)
    : (view.placement.folderLocation(parent.folderId)?.name ?? null);

function refusal(
  view: PlacementView,
  entry: EntryRef,
  repair: ReturnType<typeof projectFolderNeedsRepair>,
  current: ParentRef | null,
): EntryRefusal[] {
  if (!repair) return [];
  const name = entryNameNow(view, entry) ?? repair.name;
  if (repair.kind === "delete")
    return [
      {
        intentId: repair.intentId,
        group: "delete",
        title: deleteFailure,
        kind: "delete",
        entry,
        name,
      },
    ];
  const place = refusedMoveDestination(repair.destination, current);
  if (repair.kind !== "set-location" || !place || !current) return [];
  const destination = placeName(view, place);
  return [
    {
      intentId: repair.intentId,
      group: `move:${placementParentKey(place.parent)}`,
      title: (rows) => moveFailure(rows, destination),
      kind: "move",
      name,
      destination,
      row: {
        entry,
        name,
        typed: place.name,
        before: current,
        after: place.parent,
        ...(place.position ? { position: place.position } : {}),
      },
    },
  ];
}

export function entryRefusals(view: PlacementView, projectId: string): EntryRefusal[] {
  return [
    ...view.records.flatMap((record) => {
      const documentId = record.resource.identity?.documentId;
      return documentId
        ? refusal(
            view,
            { kind: "file", id: documentId },
            projectResourceNeedsRepair(projectId, record),
            view.placement.parentForResource(record),
          )
        : [];
    }),
    ...(view.folders ?? []).flatMap((folder) =>
      refusal(
        view,
        { kind: "folder", id: folder.folderId },
        projectFolderNeedsRepair(folder),
        view.placement.parentForFolder(folder.folderId),
      ),
    ),
  ];
}

/** Retries the intents still refused; one the writer has since superseded is gone from the list. */
export async function retryRefusals(context: EntryContext, intentIds: ReadonlySet<string>) {
  const view = await currentView(context);
  const refused = entryRefusals(view, context.projectId).filter(({ intentId }) =>
    intentIds.has(intentId),
  );
  const moves = refused.flatMap((row) => (row.kind === "move" ? [row] : []));
  if (moves[0])
    await runMove(
      context,
      moves.map(({ row }) => row),
      moves[0].destination,
    );
  for (const row of refused)
    if (row.kind === "delete") await runDelete({ ...row.entry, name: row.name }, context);
}

/** Copies a refused Copy again; the refusal resolves once the replica admits it. */
export async function retryCopyRefusal(
  context: EntryContext,
  operationId: string,
  onFailed: () => void,
) {
  const snapshot = await context.resources.readProjection(context.projectId);
  const view = { ...(await currentView(context)), operations: snapshot.operations };
  const copy = copyRefusals(view, context.projectId).find(
    (candidate) => candidate.operationId === operationId,
  )?.copy;
  if (!copy) return;
  if (await copyRows(copy, context)) await context.resources.resolveCopyRefusal(operationId);
  else onFailed();
}
