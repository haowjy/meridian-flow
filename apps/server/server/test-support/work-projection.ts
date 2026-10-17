/**
 * The real Work mutation boundary for isolated PostgreSQL adapters whose contract excludes
 * cross-domain effects: the same Work-first order, with no catalog or availability publication
 * and no pending counts, so only a known membership change touches a Work.
 */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  createWorkProjectionMutation,
  type WorkProjectionMutation,
} from "../domains/projects/adapters/work-projection-mutation.js";

export function createTestWorkProjectionMutation(db: Database): WorkProjectionMutation {
  return createWorkProjectionMutation({
    db,
    availability: { advance: async () => "0" },
    catalog: { refreshProject: async () => {}, upsertWorkAuthorities: async () => {} },
    pending: { countPendingByWorkIds: async () => new Map<WorkId, number>() },
  });
}
