/**
 * The collab-owned pending membership rule, counted per Work: what the Works boundary
 * reconciles each Work's stored count (the badge) against. One SQL aggregate per call.
 */
import type { WorkId } from "@meridian/contracts/runtime";

export type WorkDraftPendingCounts = {
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};
