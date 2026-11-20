/** Work purge's real branch disposal over Postgres, for suites that purge without a composed collab domain. */
import type { Database } from "@meridian/database";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import type { WorkBranchDisposal } from "../../projects/index.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "../adapters/drizzle-branches.js";
import { createDrizzleWorkBranchDisposal } from "../adapters/drizzle-work-tree-discard.js";
import { createBranches } from "../domain/branches.js";

export function createPostgresWorkBranchDisposal(db: Database): WorkBranchDisposal {
  const { treeLists } = createTestRemovalDeps(db);
  return createDrizzleWorkBranchDisposal(db, {
    treeLists,
    branches: createBranches({
      store: createDrizzleBranchStore(db),
      boundary: createDrizzleBranchWriteBoundary(db, createTestWorkProjectionMutation(db)),
    }),
  });
}
