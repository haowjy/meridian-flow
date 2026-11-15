/**
 * How a tree Move, Copy or delete runs. A Move or delete is appended to the copy of the list and
 * cannot fail; the server's later `dropped` comes back as a settlement and shows on the row it
 * concerns. A Copy is a route, and its failure is a toast with Retry.
 */
import { plural, t } from "@lingui/core/macro";
import type { Settlement } from "@meridian/contracts/commands";
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

/** What a Copy needs beyond a Move: the state vector of a document's open session in this tab. */
export type CopyContext = EntryContext & {
  stateVectorOf: (documentId: string) => Uint8Array | null;
};

/** A Copy the route refused: it has its own key, and Retry runs it again. */
export type CopyFailure = {
  key: string;
  sources: readonly string[];
  destination: string | null;
  /** The route's answer, in its words, when it gave one. */
  reason: string | null;
  copy: ReadyCopy;
};

/** The key of a project's failure, under that project's prefix (`entryToast(projectId)`). */
export const entryToast = (projectId: string, failure = "") => `entry:${projectId}:${failure}`;

/** Moves and deletes are appended to the copy of the list and cannot fail here; a Copy is a route. */
export function runMove(
  context: EntryContext,
  rows: readonly MoveRow[],
  onMoved?: (moved: readonly EntryRef[]) => void,
): void {
  onMoved?.(moveRows(rows, context.actions));
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

/** Toasts a refused Copy; Retry runs it again. */
function showCopyFailure(context: CopyContext, failure: CopyFailure): void {
  notifyFailure({
    key: failure.key,
    title: copyFailureTitle(failure.sources, failure.destination, failure.reason),
    onRetry: () => void runCopy(context, failure.copy),
  });
}

/** What a Copy that left something undone says, in the writer's words; null when it left nothing. */
export function copySettledNotice(settled: readonly Settlement[]): string | null {
  const returned = settled.find((one) => one.rule === "returned");
  if (returned) return t`That Work is closed, so nothing was copied.`;
  const left = settled.find((one) => one.rule === "left_out");
  if (left?.why === "would_loop") return t`A folder can't be copied into itself.`;
  if (left) return t`Part of it is gone for good, so it wasn't copied.`;
  return null;
}

export async function runCopy(
  context: CopyContext,
  copy: ReadyCopy,
  onCopied?: (copies: readonly EntryRef[]) => void,
): Promise<void> {
  try {
    const { rows, settled } = await copyRows(context.projectId, copy, context.stateVectorOf);
    if (rows.length > 0) onCopied?.(rows);
    const notice = copySettledNotice(settled);
    if (notice)
      notifyFailure({
        key: entryToast(context.projectId, crypto.randomUUID()),
        title: notice,
      });
  } catch (error) {
    showCopyFailure(context, {
      key: entryToast(context.projectId, crypto.randomUUID()),
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
 * its own. Each list takes its entries as one update.
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
    const step = list.remove(mine.map(({ entry }) => entry.id));
    taken.push({ list, step, names: mine.map(({ entry }) => entry.name) });
  }
  // In the sidebar the rows carry the delete's Undo (`TreeNotice`); a line shows only where no row
  // does: on main's Recently opened, or where main went back to when the delete took its document.
  if (context.notice && taken.length > 0 && (leaving || context.notice.at === "main"))
    shown = showDeleteNotice(context.notice, projectId, taken, leaving, covered.flat()[0] ?? "");
}

/**
 * The delete's notice, with an Undo that takes back the sidebar's own Undo step for it: whichever
 * runs first, the other has nothing left (a press ends the notice).
 */
function showDeleteNotice(
  { notices }: NonNullable<EntryContext["notice"]>,
  projectId: string,
  taken: readonly { list: EntryActions["project"]; step: TreeStep; names: string[] }[],
  leaving: string | null,
  documentId: string,
): number | null {
  const names = taken.flatMap((each) => each.names);
  const surface: NoticeSurface = leaving
    ? { kind: "band", documentId: leaving }
    : { kind: "landing" };
  const handle: DiscardUndo = {
    undo: async () => ({
      answer: (await Promise.all(taken.map(({ list, step }) => list.undo(step)))).some(Boolean)
        ? "ok"
        : "gone",
      landed: Promise.resolve(),
    }),
    end: () => {},
  };
  // The notice's one Undo covers every list's step: it ends with the last of them.
  const standing = new Set(taken.map(({ step }) => step));
  for (const { step } of taken)
    step.ended = () => {
      standing.delete(step);
      if (standing.size > 0) return;
      handle.end();
      notices.partEnded(handle);
    };
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
