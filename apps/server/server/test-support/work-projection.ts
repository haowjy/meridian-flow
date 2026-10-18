/**
 * The real Work mutation boundary for isolated PostgreSQL adapters whose contract excludes
 * cross-domain effects: the same Work-first order and touches, with no catalog or availability
 * publication.
 */
import type { Database } from "@meridian/database";
import { createDrizzleWorkDraftPendingStore } from "../domains/collab/adapters/drizzle-branch-push.js";
import {
  createWorkProjectionMutation,
  type WorkProjectionMutation,
} from "../domains/projects/adapters/work-projection-mutation.js";

export function createTestWorkProjectionMutation(db: Database): WorkProjectionMutation {
  return createWorkProjectionMutation({
    db,
    availability: { advance: async () => "0" },
    catalog: { refreshProject: async () => {}, upsertWorkAuthorities: async () => {} },
    pendingCounts: createDrizzleWorkDraftPendingStore(db),
  });
}
