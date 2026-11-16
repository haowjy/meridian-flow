/**
 * How a tree Move, Copy or delete runs. A Move or delete is appended to the copy of the list and
 * cannot fail; the server's later `dropped` comes back as a settlement and shows on the row it
 * concerns. A Copy is a route, and its failure is a toast with Retry.
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
import { revealPlaced } from "../tree-reveal";
import type { EntryRef } from "./entry";
import type { EntryActions } from "./entry-actions";
import { copyRows } from "./execute-copy";
import { moveRows } from "./execute-move";
import type { ReadyCopy, ReadyMove } from "./move-plan";
import { type EntrySelection, leaveSelections } from "./selection";

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

/** A Copy the route refused: it has its own key, and Retry runs it again unless it is final. */
type CopyFailure = {
  key: string;
  sources: readonly string[];
  destination: string | null;
  refusal: CopyRefusal;
  copy: ReadyCopy;
};

type CopyRefusal = {
  /** The route's answer, in its words, when it gave one. */
  reason: string | null;
  /** Sending it again can't land it: the Work is closed, or the writer can't copy there. */
  final: boolean;
};

/** The key of a project's failure, under that project's prefix (`entryToast(projectId)`). */
export const entryToast = (projectId: string, failure = "") => `entry:${projectId}:${failure}`;

/**
 * Moves and deletes are appended to the copy of the list and cannot fail here; a Copy is a route.
 * Either shows where its rows landed at once (`revealPlaced`), selected in `selection`.
 */
export function runMove(
  context: EntryContext,
  move: ReadyMove,
  selection: EntrySelection | null,
): void {
  const moved = moveRows(move, context.actions);
  if (moved.length > 0) revealPlaced(move.to.parentId, moved, selection);
}

/** What the route said was wrong, when it said. */
function refusalOf(error: unknown): CopyRefusal {
  const retry = (reason: string | null) => ({ reason, final: false });
  const final = (reason: string) => ({ reason, final: true });
  if (!isMeridianApiError(error)) return retry(null);
  const { details } = error;
  const reason = details && typeof details === "object" && "reason" in details && details.reason;
  if (reason === "source_behind") return retry(t`The latest edits hadn't reached the server.`);
  switch (error.code) {
    case "not_found":
    case "stale_source":
      return retry(t`A source is no longer there.`);
    case "destination_missing":
    case "stale_target":
      return retry(t`The destination is no longer there.`);
    case "permission_denied":
      return final(t`You can't copy there.`);
    case "work_archived":
    case "work_deleted":
      return final(t`The Work was closed.`);
    case "work_missing":
      return final(t`That Work isn't available.`);
    default:
      return retry(null);
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

/** Toasts a refused Copy; Retry, offered unless the refusal is final, runs it again. */
function showCopyFailure(
  context: EntryContext,
  failure: CopyFailure,
  selection: EntrySelection | null,
): void {
  notifyFailure({
    key: failure.key,
    title: copyFailureTitle(failure.sources, failure.destination, failure.refusal.reason),
    onRetry: failure.refusal.final
      ? undefined
      : () => void runCopy(context, failure.copy, selection),
  });
}

export async function runCopy(
  context: EntryContext,
  copy: ReadyCopy,
  selection: EntrySelection | null,
): Promise<void> {
  const { copies, answered } = copyRows(context.projectId, copy);
  revealPlaced(copy.into, copies, selection);
  try {
    await answered;
  } catch (error) {
    leaveSelections(copies);
    showCopyFailure(
      context,
      {
        key: entryToast(context.projectId, crypto.randomUUID()),
        sources: copy.copies.map(({ name }) => name),
        destination: copy.destinationName,
        refusal: refusalOf(error),
        copy,
      },
      selection,
    );
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
  context: Omit<EntryContext, "actions">,
  /** Each entry with the actions of the tree it was shown in: one gesture can span several. */
  requested: readonly (EntryRef & { name: string; actions: EntryActions })[],
): Promise<void> {
  const { projectId, removal } = context;
  const held = requested.map((entry) => ({ entry, ...entry.actions.holding(entry.id) }));
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
