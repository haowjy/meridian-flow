/**
 * How a tree Move, Copy or delete runs. A Move or delete is appended to the copy of the list and
 * cannot fail; the server's later `dropped` comes back as a settlement and shows on the row it
 * concerns. A Copy is a route, and its failure is a toast, with Retry unless sending it again
 * can't land it.
 */
import { t } from "@lingui/core/macro";
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
import { revealPlaced } from "../tree-reveal";
import type { EntryRef } from "./entry";
import type { EntryActions } from "./entry-actions";
import { copyRows, type RoomVersionOf } from "./execute-copy";
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

/** What a Copy needs beyond a Move: the room version of a document's open session in this tab. */
export type CopyContext = EntryContext & {
  roomVersionOf: RoomVersionOf;
};

/** A Copy the route refused: it has its own key, and Retry runs it again unless it is final. */
type CopyFailure = {
  key: string;
  error: unknown;
  copy: ReadyCopy;
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

/** Why the route refused for good, where it did: the Work is closed, or the writer can't copy there. */
function finalRefusalReason(error: unknown): string | undefined {
  if (!isMeridianApiError(error)) return undefined;
  if (error.code === "permission_denied") return t`No access`;
  if (["work_archived", "work_deleted", "work_missing"].includes(error.code)) return t`Work closed`;
  return undefined;
}

/** Why the server left a copy out, where sending it again would leave it out the same way. */
function settledReason(undone: readonly Settlement[]): string | undefined {
  if (
    undone.some(
      (one) => one.rule === "returned" && ["work_archived", "work_deleted"].includes(one.why),
    )
  )
    return t`Work closed`;
  if (undone.some((one) => one.rule === "left_out" && one.why === "would_loop"))
    return t`Folder into itself`;
  return undefined;
}

/** Toasts a refused Copy; Retry, offered unless the refusal is final, runs it again. */
function showCopyFailure(
  context: CopyContext,
  failure: CopyFailure,
  selection: EntrySelection | null,
): void {
  const reason = finalRefusalReason(failure.error);
  notifyFailure({
    key: failure.key,
    title: t`Couldn't copy`,
    reason,
    detail: failure.error,
    action: reason
      ? undefined
      : { label: t`Retry`, run: () => void runCopy(context, failure.copy, selection) },
  });
}

export async function runCopy(
  context: CopyContext,
  copy: ReadyCopy,
  selection: EntrySelection | null,
): Promise<void> {
  const { copies, answered } = copyRows(context.projectId, copy, context.roomVersionOf);
  revealPlaced(copy.into, copies, selection);
  try {
    const settled = await answered;
    // The Work closed, or a source was gone or would land inside itself: something wasn't copied.
    const undone = settled.filter((one) => one.rule === "returned" || one.rule === "left_out");
    if (undone.length > 0) {
      leaveSelections(copies);
      notifyFailure({
        key: entryToast(context.projectId, crypto.randomUUID()),
        title: t`Couldn't copy`,
        reason: settledReason(undone),
        detail: undone,
      });
    }
  } catch (error) {
    leaveSelections(copies);
    showCopyFailure(
      context,
      {
        key: entryToast(context.projectId, crypto.randomUUID()),
        error,
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
 * runs first, the other has nothing left (a press ends the notice). It also ends when its steps
 * rest (an Apply or a create shows what they took again): it can't hide its Undo for now as the
 * rows do, and the rows and Ctrl+Z keep it.
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
    ? { kind: "band", documentId: leaving, draftId: null }
    : { kind: "landing" };
  const handle: DiscardUndo = {
    undo: async () => ({
      answer: (await Promise.all(taken.map(({ list, step }) => list.undo(step)))).some(Boolean)
        ? "ok"
        : "gone",
    }),
    end: () => {},
  };
  // The notice's one Undo covers every list's step: it ends when the last of them ends or rests.
  const standing = new Set(taken.map(({ step }) => step));
  for (const { step } of taken) {
    const leave = () => {
      if (!standing.delete(step) || standing.size > 0) return;
      handle.end();
      notices.partEnded(handle);
    };
    step.ended = leave;
    step.rested = leave;
  }
  const id = notices.showDiscard({
    projectId,
    draftId: deleteNoticeKey(projectId),
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
