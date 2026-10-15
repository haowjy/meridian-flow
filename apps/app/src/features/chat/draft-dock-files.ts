/**
 * draft-dock-files: what the chat's draft dock shows of each draft file, for one chat. Pure data, no React.
 *
 * A file is in the draft dock when the server says the chat has pending AI edit parts in a draft that has
 * changes (`GET /api/threads/:t/draft-files`, SQL only). The draft dock projects a file's changes only when it
 * is expanded (`useDraftView`) and keeps the changes whose attribution hint names this chat.
 */

import type { ReviewFileTarget } from "@/client/query/work-draft-files";

export type DockFile = {
  row: ReviewFileTarget;
  name: string;
};

/** The draft dock's lines for the chat's draft files. */
export function dockFiles(
  files: readonly ReviewFileTarget[],
  nameOf: (row: ReviewFileTarget) => string,
): DockFile[] {
  return files.map((row) => ({ row, name: nameOf(row) }));
}
