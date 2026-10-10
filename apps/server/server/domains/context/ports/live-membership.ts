/** The live manifest's writer a cross-project move needs, until lane M retires the manifest. */
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

export interface LiveMembership {
  /**
   * Inside a cross-project move's transaction, before its arrival settles: the documents leave
   * `from`'s live manifest and join `to`'s.
   */
  transfer(
    documentIds: readonly DocumentId[],
    projects: { from: ProjectId; to: ProjectId },
  ): Promise<void>;
}
