/** The strip's files: a document with text is pressed whole; a move or delete is its tree line. */
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { listedItemChanges, type ReviewChange } from "@/features/draft-review/review-model";
export type DockFile = {
  row: ReviewFileTarget;
  name: string;
  changes: readonly ReviewChange[];
  actionable: readonly ReviewChange[];
  /** Every change its draft holds is this chat's: the strip's Apply leaves nothing of it. */
  alone: boolean;
  /** Its text changes are not listed, only counted, and the strip's commands take it whole. */
  whole: boolean;
  /** The changes it counts: the listed ones, or for a `whole` file the list's own count. */
  count: number;
};
/**
 * Someone besides this chat wrote in the draft: another chat, the writer's own typing, or a
 * change of unknown author. Every other draft is this chat's alone.
 */
export function isSharedDraft(draft: ReviewFileTarget["draft"] | undefined, threadId: string) {
  return (
    !!draft &&
    !draft.wholeItem &&
    (draft.unattributed || draft.actorThreads.some((chat) => chat.threadId !== threadId))
  );
}
export function dockFile(
  row: ReviewFileTarget,
  name: string,
  items: readonly ReviewChange[],
  threadId: string,
): DockFile {
  const changes = items.filter((change) => !change.attributed || change.members.includes(threadId));
  return {
    row,
    name,
    changes,
    actionable: changes,
    alone: changes.length === items.length,
    whole: false,
    count: changes.length,
  };
}
/** A document with text: the list says what changed; the press takes it whole. */
export function wholeDockFile(row: ReviewFileTarget, name: string): DockFile {
  const changes = listedItemChanges(row.draft, []);
  const texts = row.draft.wholeItem ? 0 : row.draft.textChanges;
  return {
    row,
    name,
    changes,
    actionable: changes,
    alone: true,
    whole: true,
    count: changes.length + texts,
  };
}
export const isOnStrip = (file: DockFile) => file.count > 0;
export const totalChanges = (files: readonly DockFile[]) =>
  files.reduce((sum, file) => sum + file.count, 0);
