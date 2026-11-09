/**
 * The one way a tree Move, Copy or delete runs and fails. A failure is data with its own key,
 * whether the replica refused it at once (`run…`) or the server refused it later
 * (`entryFailures`). One function titles it, one shows it and one retries it, re-reading the
 * replica first: a row the writer has changed since is left alone.
 */
import { plural, t } from "@lingui/core/macro";
import {
  type ParentRef,
  placementParentKey,
  projectFolderNeedsRepair,
  projectResourceNeedsRepair,
} from "@meridian/resource-replica";
import { refusedMoveDestination } from "@/client/query/context-catalog-projection";
import { getContextTabs } from "@/client/stores";
import { notifyFailure } from "@/components/app/failure-toast";
import type { RemovedNoticeStore } from "../removed-notice-store";
import { copyFailures, copyFailureTitle } from "./copy-refusal";
import type { EntryRef } from "./entry";
import { copyRows } from "./execute-copy";
import { currentView, moveRows, type ReplicaContext } from "./execute-move";
import {
  entryNameNow,
  type MoveRow,
  type PlacementView,
  parentName,
  parentOf,
  type ReadyCopy,
  sameParent,
  within,
} from "./move-plan";

export type EntryContext = ReplicaContext & {
  notices?: Pick<RemovedNoticeStore, "markOwnRemoval"> | null;
};

export type EntryFailure = { key: string } & (
  | { kind: "move"; rows: readonly MoveRow[]; destination: string | null }
  | { kind: "delete"; entry: EntryRef; name: string }
  | {
      kind: "copy";
      sources: readonly string[];
      destination: string | null;
      reason: string | null;
      /** What Retry copies; absent once a source or the destination is gone. */
      copy?: ReadyCopy;
      /** A Copy the server refused: the journal keeps it until the toast closes or Retry lands. */
      operationId?: string;
    }
);

/** What the server refused and the intents behind it. */
export type RefusedFailure = { failure: EntryFailure; intents: readonly string[] };

/** The key of a project's failure, under that project's prefix (`entryToast(projectId)`). */
export const entryToast = (projectId: string, failure = "") => `entry:${projectId}:${failure}`;

export function failureTitle(failure: EntryFailure): string {
  if (failure.kind === "copy")
    return copyFailureTitle(failure.sources, failure.destination, failure.reason);
  if (failure.kind === "delete") return t`Couldn't delete ${failure.name}.`;
  const { rows, destination } = failure;
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

/** Toasts a failure. `onHandled` runs once the writer closes it or presses Retry. */
export function showFailure(
  context: EntryContext,
  failure: EntryFailure,
  onHandled?: () => void,
): void {
  notifyFailure({
    key: failure.key,
    title: failureTitle(failure),
    onClose: () => {
      onHandled?.();
      if (failure.kind === "copy" && failure.operationId)
        void context.resources.resolveCopyRefusal(failure.operationId);
    },
    onRetry:
      failure.kind !== "copy" || failure.copy
        ? () => {
            onHandled?.();
            return retryFailure(context, failure, onHandled);
          }
        : undefined,
  });
}

async function retryFailure(
  context: EntryContext,
  failure: EntryFailure,
  onHandled?: () => void,
): Promise<void> {
  const view = await currentView(context);
  if (failure.kind === "move") {
    const rows = failure.rows.filter((row) => {
      const parent = parentOf(view, row.entry);
      return (
        entryNameNow(view, row.entry) === row.name &&
        parent !== null &&
        sameParent(parent, row.before)
      );
    });
    await runMove(context, rows, failure.destination);
  } else if (failure.kind === "delete") {
    if (entryNameNow(view, failure.entry))
      await runDelete(context, { ...failure.entry, name: failure.name });
  } else if (failure.copy) {
    const copies = failure.copy.copies.flatMap((row) => {
      const name = entryNameNow(view, row.entry);
      return name ? [{ ...row, name }] : [];
    });
    const copy = { ...failure.copy, copies };
    if (copies.length < failure.copy.copies.length || !parentName(view, copy.into))
      showFailure(
        context,
        {
          ...failure,
          copy: undefined,
          reason: t`A source or the destination is no longer there.`,
        },
        onHandled,
      );
    else if (!(await copyRows(copy, context)))
      showFailure(context, { ...failure, copy }, onHandled);
    else if (failure.operationId) await context.resources.resolveCopyRefusal(failure.operationId);
  }
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
  showFailure(context, {
    key: entryToast(context.projectId, crypto.randomUUID()),
    kind: "move",
    rows: rows.filter(({ entry }) => refused.has(entry)),
    destination,
  });
}

export async function runCopy(
  context: EntryContext,
  copy: ReadyCopy,
  onCopied?: (copies: readonly EntryRef[]) => void,
): Promise<void> {
  const rows = await copyRows(copy, context);
  if (rows) onCopied?.(rows);
  else
    showFailure(context, {
      key: entryToast(context.projectId, crypto.randomUUID()),
      kind: "copy",
      sources: copy.copies.map(({ name }) => name),
      destination: copy.destinationName,
      reason: null,
      copy,
    });
}

/** The documents on the writer's own tabs that deleting `entry` takes away. */
async function ownRemovals(context: EntryContext, entry: EntryRef): Promise<string[]> {
  if (entry.kind === "file") return [entry.id];
  const { projectId } = context;
  const view = await currentView(context);
  return getContextTabs(projectId).tabs.flatMap((tab) =>
    tab.kind !== "new" &&
    within(view, parentOf(view, { kind: "file", id: tab.documentId }), entry.id)
      ? [tab.documentId]
      : [],
  );
}

export async function runDelete(
  context: EntryContext,
  { name, ...entry }: EntryRef & { name: string },
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
    showFailure(context, {
      key: entryToast(projectId, crypto.randomUUID()),
      kind: "delete",
      entry,
      name,
    });
  }
}

function rowFailure(
  projectId: string,
  view: PlacementView,
  entry: EntryRef,
  repair: ReturnType<typeof projectFolderNeedsRepair>,
  current: ParentRef | null,
): RefusedFailure | null {
  if (!repair) return null;
  const name = entryNameNow(view, entry) ?? repair.name;
  const intents = [repair.intentId];
  if (repair.kind === "delete")
    return {
      intents,
      failure: {
        key: entryToast(projectId, `delete:${repair.intentId}`),
        kind: "delete",
        entry,
        name,
      },
    };
  const place = refusedMoveDestination(repair.destination, current);
  if (repair.kind !== "set-location" || !place || !current) return null;
  const row: MoveRow = {
    entry,
    name,
    typed: place.name,
    before: current,
    after: place.parent,
    ...(place.position ? { position: place.position } : {}),
  };
  return {
    intents,
    failure: {
      key: entryToast(projectId, `move:${placementParentKey(place.parent)}`),
      kind: "move",
      rows: [row],
      destination: parentName(view, place.parent),
    },
  };
}

/** What the server refused, leaving out `handled` intents. Moves to one place are one failure. */
export function entryFailures(
  view: Parameters<typeof copyFailures>[0],
  projectId: string,
  handled: ReadonlySet<string> = new Set(),
): RefusedFailure[] {
  const rows = [
    ...view.records.map((record) => {
      const documentId = record.resource.identity?.documentId;
      return documentId
        ? rowFailure(
            projectId,
            view,
            { kind: "file", id: documentId },
            projectResourceNeedsRepair(projectId, record),
            view.placement.parentForResource(record),
          )
        : null;
    }),
    ...(view.folders ?? []).map((folder) =>
      rowFailure(
        projectId,
        view,
        { kind: "folder", id: folder.folderId },
        projectFolderNeedsRepair(folder),
        view.placement.parentForFolder(folder.folderId),
      ),
    ),
    ...copyFailures(view, projectId),
  ];
  const failures = new Map<string, RefusedFailure>();
  for (const refused of rows) {
    if (!refused || refused.intents.some((intent) => handled.has(intent))) continue;
    const { failure, intents } = refused;
    const same = failures.get(failure.key);
    failures.set(
      failure.key,
      same?.failure.kind === "move" && failure.kind === "move"
        ? {
            intents: [...same.intents, ...intents],
            failure: { ...failure, rows: [...same.failure.rows, ...failure.rows] },
          }
        : refused,
    );
  }
  return [...failures.values()];
}
