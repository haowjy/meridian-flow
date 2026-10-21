/** The dock reads the same group projection as the editor. Unknown attribution never hides text. */
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { DraftChangesData } from "@/features/draft-review/draft-changes";
import type { ReviewChange } from "@/features/draft-review/review-model";
export type DockFile = {
  row: ReviewFileTarget;
  name: string;
  status: "loading" | "error" | "ready";
  retry: (() => void) | null;
  changes: readonly ReviewChange[];
  actionable: readonly ReviewChange[];
};
export function dockFile(
  row: ReviewFileTarget,
  name: string,
  view: Pick<DraftChangesData, "status" | "items" | "retry"> | undefined,
  threadId: string,
): DockFile {
  const changes = (view?.items ?? [])
    .map((item) => item.change)
    .filter((change) => !change.attributed || change.members.includes(threadId));
  return {
    row,
    name,
    status:
      view?.status === "ready" || view?.status === "gone"
        ? "ready"
        : view?.status === "error"
          ? "error"
          : "loading",
    retry: view?.retry ?? null,
    changes,
    actionable: view?.status === "ready" ? changes : [],
  };
}
export const isOnStrip = (file: DockFile) => file.status !== "ready" || file.changes.length > 0;
export const totalChanges = (files: readonly DockFile[]) =>
  files.some((file) => file.status !== "ready")
    ? null
    : files.reduce((sum, file) => sum + file.changes.length, 0);
