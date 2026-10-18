/** Work purge's real branch disposal over Postgres, for suites that purge without a composed collab domain. */
import type { Database } from "@meridian/database";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createDrizzleContextCatalog } from "../../context/index.js";
import type { WorkBranchDisposal } from "../../projects/index.js";
import { createDrizzleWorkBranchDisposal } from "../adapters/drizzle-branch-discard.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "../adapters/drizzle-branches.js";
import { createBranches } from "../domain/branches.js";
export function createPostgresWorkBranchDisposal(db: Database): WorkBranchDisposal {
  return createDrizzleWorkBranchDisposal(db, {
    branches: createBranches({
      store: createDrizzleBranchStore(db),
      boundary: createDrizzleBranchWriteBoundary(db, createTestWorkProjectionMutation(db)),
    }),
    catalog: createDrizzleContextCatalog(db),
  });
}
