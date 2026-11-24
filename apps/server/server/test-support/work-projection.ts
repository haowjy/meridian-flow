import type { Database } from "@meridian/database";
import { createDrizzleWorkDraftPendingStore } from "../domains/collab/adapters/drizzle-work-draft-pending.js";
import {
  createWorkProjectionMutation,
  type WorkProjectionMutation,
} from "../domains/projects/adapters/work-projection-mutation.js";

export function createTestWorkProjectionMutation(db: Database): WorkProjectionMutation {
  return createWorkProjectionMutation({
    db,
    draftOwnerHints: { publishDraftHints: () => {} },
    pendingCounts: createDrizzleWorkDraftPendingStore(db),
  });
}
