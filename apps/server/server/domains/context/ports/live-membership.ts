/** The canonical live-membership authority, as a move needs it (contract §9.3, §10). */
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

export interface LiveMembership {
  /** The project's live manifest members, read in the caller's transaction. */
  members(projectId: ProjectId): Promise<ReadonlySet<string>>;
  /**
   * Inside a cross-project move's transaction, before its arrival settles: the documents leave
   * `from`'s live manifest and join `to`'s.
   */
  transfer(
    documentIds: readonly DocumentId[],
    projects: { from: ProjectId; to: ProjectId },
  ): Promise<void>;
}
