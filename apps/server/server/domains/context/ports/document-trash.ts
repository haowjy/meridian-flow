/** Restorable document tombstones exposed through the project trash. */
import type { ProjectId } from "@meridian/contracts";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";

export type DocumentTrash = {
  /** Lists current restorable removals, newest first. */
  list(projectId: ProjectId): Promise<readonly DocumentTrashEntry[]>;
};
