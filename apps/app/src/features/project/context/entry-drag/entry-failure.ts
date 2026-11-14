/**
 * The one way a tree Move, Copy or delete runs and fails when no list could take it: a failure is
 * data with its own key, one function titles it, one shows it and one retries it. A refusal the
 * server makes later is not here: it comes back as a settlement and shows on the row it concerns.
 */
import { plural, t } from "@lingui/core/macro";
import { descendantsOf, type TreeProjection } from "@meridian/project-tree";
import { isMeridianApiError } from "@/client/api/meridian-error";
import { notifyFailure } from "@/components/app/failure-toast";
import type { TreeStep } from "@/core/project-tree/tree-undo";
import {
  type DiscardUndo,
  type DraftNotices,
  deleteNoticeKey,
  type NoticeSurface,
} from "@/features/draft-review/draft-notices";
import type { ContextRemovalCoordinator } from "../context-removal-coordinator";
import type { EntryRef } from "./entry";
import type { EntryActions } from "./entry-actions";
import { copyRows } from "./execute-copy";
import { moveRows } from "./execute-move";
import type { MoveRow, ReadyCopy } from "./move-plan";
import { leaveSelections } from "./selection";

export type EntryContext = {
  projectId: string;
  actions: EntryActions;
  removal?: Pick<ContextRemovalCoordinator, "beginOwnRemoval"> | null;
  /**
   * Where a delete's notice shows: `tree` in the sidebar, `main` on Recently opened. A delete of
   * the document main shows follows main to where it goes back to. None: no notice.
   */
  notice?: { notices: DraftNotices; at: "tree" | "main" } | null;
};

export type EntryFailure = { key: string } & (
  | { kind: "move"; rows: readonly MoveRow[]; destination: string | null }
  | { kind: "delete"; entry: EntryRef; name: string }
  | {
      kind: "copy";
      sources: readonly string[];
      destination: string | null;
      /** The route's answer, in its words, when it gave one. */
      reason: string | null;
      copy: ReadyCopy;
    }
);

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

/** Toasts a failure; Retry runs it again. */
export function showFailure(context: EntryContext, failure: EntryFailure): void {
  notifyFailure({
    key: failure.key,
    title: failureTitle(failure),
    onRetry: () => retryFailure(context, failure),
  });
}

async function retryFailure(context: EntryContext, failure: EntryFailure): Promise<void> {
  if (failure.kind === "move") await runMove(context, failure.rows, failure.destination);
  else if (failure.kind === "delete")
    await runDelete(context, [{ ...failure.entry, name: failure.name }]);
  else await runCopy(context, failure.copy);
}

export async function runMove(
  context: EntryContext,
  rows: readonly MoveRow[],
  destination: string | null,
  onMoved?: (moved: readonly EntryRef[]) => void,
): Promise<void> {
  const { moved, failed } = moveRows(rows, context.actions);
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

/** What the route said was wrong, when it said. */
function reasonOf(error: unknown): string | null {
  if (!isMeridianApiError(error)) return null;
  const { details } = error;
  const reason = details && typeof details === "object" && "reason" in details && details.reason;
  if (reason === "source_behind") return t`The latest edits hadn't reached the server.`;
  if (reason === "no_draft") return t`That Work no longer has a draft of it.`;
  switch (error.code) {
    case "not_found":
    case "stale_source":
      return t`A source is no longer there.`;
    case "destination_missing":
    case "stale_target":
      return t`The destination is no longer there.`;
    case "permission_denied":
      return t`You can't copy there.`;
    case "context_unavailable":
      return t`That Work isn't available.`;
    default:
      return null;
  }
}

function copyFailureTitle(
  sources: readonly string[],
  destination: string | null,
  reason: string | null,
): string {
  const [only] = sources;
  const said =
    sources.length === 1 && only
      ? destination
        ? t`Couldn't copy ${only} to ${destination}.`
        : t`Couldn't copy ${only}.`
      : destination
        ? plural(sources.length, {
            one: `Couldn't copy # item to ${destination}.`,
            other: `Couldn't copy # items to ${destination}.`,
          })
        : plural(sources.length, {
            one: "Couldn't copy # item.",
            other: "Couldn't copy # items.",
          });
  return reason ? `${said} ${reason}` : said;
}

export async function runCopy(
  context: EntryContext,
  copy: ReadyCopy,
  onCopied?: (copies: readonly EntryRef[]) => void,
): Promise<void> {
  try {
    onCopied?.(await copyRows(context.projectId, copy));
  } catch (error) {
    showFailure(context, {
      key: entryToast(context.projectId, crypto.randomUUID()),
      kind: "copy",
      sources: copy.copies.map(({ name }) => name),
      destination: copy.destinationName,
      reason: reasonOf(error),
      copy,
    });
  }
}

/** The documents deleting `entry` takes away. */
export function ownRemovals(projection: TreeProjection | null, entry: EntryRef): string[] {
  if (entry.kind === "file" || !projection) return [entry.id];
  return descendantsOf(projection, entry.id).filter(
    (id) => projection.nodes.get(id)?.kind !== "folder",
  );
}

/**
 * Deletes one gesture's entries: one own removal covers every document they take away, so main's
 * go-back skips all of them. An entry inside another one's folder goes with that folder, never on
 * its own. Each list takes its entries as one update; a list that cannot toasts and keeps its
 * documents.
 */
export async function runDelete(
  context: EntryContext,
  requested: readonly (EntryRef & { name: string })[],
): Promise<void> {
  const { actions, projectId, removal } = context;
  const held = requested.map((entry) => ({ entry, ...actions.holding(entry.id) }));
  const entries = held.filter(({ entry, replay }) => {
    if (!replay) return true;
    return !held.some(
      (other) =>
        other.entry.kind === "folder" &&
        other.entry.id !== entry.id &&
        descendantsOf(replay, other.entry.id).includes(entry.id),
    );
  });
  const covered = entries.map(({ entry, replay }) => ownRemovals(replay, entry));
  leaveSelections([
    ...requested,
    ...entries.flatMap(({ entry, replay }) =>
      entry.kind === "folder" && replay
        ? descendantsOf(replay, entry.id).map((id) => ({
            kind: replay.nodes.get(id)?.kind === "folder" ? ("folder" as const) : ("file" as const),
            id,
          }))
        : [],
    ),
  ]);
  let shown: number | null = null;
  const leaving =
    removal?.beginOwnRemoval(projectId, covered.flat(), (landing) => {
      if (shown !== null)
        context.notice?.notices.landed(deleteNoticeKey(projectId), shown, landing);
    }) ?? null;
  const taken: { list: EntryActions["project"]; step: TreeStep; names: string[] }[] = [];
  for (const list of new Set(entries.map((item) => item.list))) {
    const mine = entries.filter((item) => item.list === list);
    const removed = list.remove(mine.map(({ entry }) => entry.id));
    if (removed.ok) {
      taken.push({ list, step: removed.step, names: mine.map(({ entry }) => entry.name) });
      continue;
    }
    for (const item of mine) {
      const { name, ...entry } = item.entry;
      showFailure(context, {
        key: entryToast(projectId, crypto.randomUUID()),
        kind: "delete",
        entry,
        name,
      });
    }
  }
  if (context.notice && taken.length > 0)
    shown = showDeleteNotice(context.notice, projectId, taken, leaving, covered.flat()[0] ?? "");
}

/**
 * The delete's notice, with an Undo that takes back the sidebar's own Undo step for it: whichever
 * runs first, the other has nothing left (a press ends the notice).
 */
function showDeleteNotice(
  { notices, at }: NonNullable<EntryContext["notice"]>,
  projectId: string,
  taken: readonly { list: EntryActions["project"]; step: TreeStep; names: string[] }[],
  leaving: string | null,
  documentId: string,
): number | null {
  const names = taken.flatMap((each) => each.names);
  const surface: NoticeSurface = leaving
    ? { kind: "band", documentId: leaving }
    : { kind: at === "main" ? "landing" : "tree" };
  const handle: DiscardUndo = {
    undo: () => ({
      answer: taken.map(({ list, step }) => list.undo(step)).some(Boolean) ? "ok" : "gone",
      landed: Promise.resolve(),
    }),
    end: () => {},
  };
  for (const { step } of taken) step.ended = () => notices.partEnded(handle);
  const id = notices.showDiscard({
    projectId,
    ownerKey: deleteNoticeKey(projectId),
    // Leaving main's document, the notice follows main to where it goes back to (`landed`).
    surface,
    parts: [
      {
        documentId: leaving ?? documentId,
        name: names[0] ?? "",
        scope: "deleted",
        count: names.length,
        handle,
      },
    ],
  });
  return id;
}
