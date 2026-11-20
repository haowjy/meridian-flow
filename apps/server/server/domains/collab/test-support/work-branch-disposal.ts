/** Work purge's real branch disposal over Postgres, for suites that purge without a composed collab domain. */
import type { Database } from "@meridian/database";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import type { WorkBranchDisposal } from "../../projects/index.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "../adapters/drizzle-branches.js";
import { createDrizzleCollabPersistence } from "../adapters/drizzle-journal.js";
import { createDrizzleWorkBranchDisposal } from "../adapters/drizzle-work-disposal.js";
import { createBranches } from "../domain/branches.js";

export function createPostgresWorkBranchDisposal(db: Database): WorkBranchDisposal {
  const { treeLists } = createTestRemovalDeps(db);
  return createDrizzleWorkBranchDisposal(db, {
    treeLists,
    live: createDrizzleCollabPersistence(db).journal,
    // No room is open and no derivation runs in these suites.
    liveCoordinator: { deliver: async () => {} },
    onCommitted: async () => {},
    branches: createBranches({
      store: createDrizzleBranchStore(db),
      boundary: createDrizzleBranchWriteBoundary(db, createTestWorkProjectionMutation(db)),
    }),
  });
}
