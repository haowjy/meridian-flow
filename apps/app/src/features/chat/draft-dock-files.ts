/**
 * draft-dock-files — what the composer strip shows of each draft file, for one
 * chat. Pure data, no React.
 *
 * A change is this chat's when the chat wrote any of its visible operations
 * (`ReviewChange.threadIds`); the writer's own edits inside it ride with it,
 * and other chats' separate changes and the writer's separate changes are in
 * no chat's strip. A file stays a candidate until its preview lands: only then
 * is it known whether the chat still has a change in it.
 */

import type { DraftPreviewEntry } from "@/client/query/useDraftPreview";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { listablePreview } from "@/features/draft-review/draft-changes";
import {
  type ReviewChange,
  reviewChangesOfPreview,
  wholeItemChange,
} from "@/features/draft-review/review-changes";

export type DockFile = {
  row: ReviewFileTarget;
  name: string;
  status: "loading" | "error" | "ready";
  /** Present when the preview failed to read. */
  retry: (() => void) | null;
  /** This chat's changes in the file, in document order (empty until the preview lands). */
  changes: readonly ReviewChange[];
  /** The ones Apply and Discard take: every actionable change of the chat, including whole-draft items. */
  actionable: readonly ReviewChange[];
};

const NO_CHANGES: readonly ReviewChange[] = [];

/**
 * One candidate file as the strip shows it. The entry's preview is already
 * without the operations the command records hide (a batch's queued selections,
 * a claim in flight), so a sent change has left the strip.
 */
export function dockFile(
  row: ReviewFileTarget,
  name: string,
  entry: DraftPreviewEntry | undefined,
  threadId: string,
): DockFile {
  const base = {
    row,
    name,
    retry: null,
    changes: NO_CHANGES,
    actionable: NO_CHANGES,
  } satisfies Omit<DockFile, "status">;
  if (row.draft.draftGeneration === null) {
    const changes = [wholeItemChange(row.draft)].filter((change) =>
      change.threadIds.includes(threadId),
    );
    return { ...base, status: "ready", changes, actionable: changes };
  }
  if (entry?.status === "error") return { ...base, status: "error", retry: entry.retry };
  if (entry?.status !== "ready") return { ...base, status: "loading" };
  // A draft that is gone has no change of the chat's left to show.
  if (entry.preview.status === "gone") return { ...base, status: "ready" };
  const active = listablePreview(entry.preview);
  if (!active) return { ...base, status: "loading" };

  const changes = reviewChangesOfPreview(active).filter((change) =>
    change.threadIds.includes(threadId),
  );
  return {
    ...base,
    status: "ready",
    changes,
    actionable: changes.filter((change) => change.target.kind !== "display"),
  };
}

/** On the strip while its preview is unread, and once read only if the chat has a change in it. */
export function isOnStrip(file: DockFile): boolean {
  return file.status !== "ready" || file.changes.length > 0;
}

/** The changes across files, or null while any preview is unread: a count is never read from a partial answer. */
export function totalChanges(files: readonly DockFile[]): number | null {
  if (files.some((file) => file.status !== "ready")) return null;
  return files.reduce((sum, file) => sum + file.changes.length, 0);
}
