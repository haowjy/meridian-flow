/** The dock reads the same group projection as the editor. Unknown attribution never hides text. */
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { DraftChangesData } from "@/features/draft-review/draft-changes";
import { listedItemChanges, type ReviewChange } from "@/features/draft-review/review-model";
export type DockFile = {
  row: ReviewFileTarget;
  name: string;
  status: "loading" | "error" | "ready";
  retry: (() => void) | null;
  changes: readonly ReviewChange[];
  actionable: readonly ReviewChange[];
  /** Read, and every change its draft holds is this chat's: the strip's Apply leaves nothing of it. */
  alone: boolean;
  /**
   * Read from the owner list, with no room: its text changes are not listed, only counted, and
   * the strip's commands take its whole draft.
   */
  whole: boolean;
  /** The changes it counts: the listed ones, or for a `whole` file the list's own count. */
  count: number;
};
export function dockFile(
  row: ReviewFileTarget,
  name: string,
  view: Pick<DraftChangesData, "status" | "items" | "retry"> | undefined,
  threadId: string,
): DockFile {
  const items = view?.items ?? [];
  const changes = items
    .map((item) => item.change)
    .filter((change) => !change.attributed || change.members.includes(threadId));
  const read = view?.status === "ready" || view?.status === "gone";
  return {
    row,
    name,
    status: read ? "ready" : view?.status === "error" ? "error" : "loading",
    retry: view?.retry ?? null,
    changes,
    actionable: view?.status === "ready" ? changes : [],
    alone: read && changes.length === items.length,
    whole: false,
    count: changes.length,
  };
}
/** A drafted row the strip holds no room for. The list says what changed; the server cuts the draft. */
export function wholeDockFile(row: ReviewFileTarget, name: string): DockFile {
  const changes = listedItemChanges(row.draft, []);
  const texts = row.draft.wholeItem ? 0 : row.draft.textChanges;
  return {
    row,
    name,
    status: "ready",
    retry: null,
    changes,
    actionable: changes,
    alone: true,
    whole: true,
    count: changes.length + texts,
  };
}
export const isOnStrip = (file: DockFile) => file.status !== "ready" || file.count > 0;
export const totalChanges = (files: readonly DockFile[]) =>
  files.some((file) => file.status !== "ready")
    ? null
    : files.reduce((sum, file) => sum + file.count, 0);
