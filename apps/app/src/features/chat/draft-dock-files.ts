/**
 * draft-dock-files: what the composer strip shows of each draft file, for one chat. Pure data, no React.
 *
 * A file is on the strip when the server says the chat has pending AI edit parts in a draft that has
 * changes (`GET /api/threads/:t/draft-files`, SQL only). The strip projects a file's changes only when it
 * is expanded (`useDraftView`) and keeps the changes whose attribution hint names this chat.
 */

import type { ReviewFileTarget } from "@/client/query/work-draft-files";

export type DockFile = {
  row: ReviewFileTarget;
  name: string;
};

/** The strip's lines for the chat's draft files. */
export function dockFiles(
  files: readonly ReviewFileTarget[],
  nameOf: (row: ReviewFileTarget) => string,
): DockFile[] {
  return files.map((row) => ({ row, name: nameOf(row) }));
}
