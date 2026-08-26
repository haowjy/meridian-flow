/** Read port for the collab-owned pending-draft projection used by Work catalogs. */
import type { WorkId } from "@meridian/contracts/runtime";

export type WorkDraftPendingCounts = {
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};
