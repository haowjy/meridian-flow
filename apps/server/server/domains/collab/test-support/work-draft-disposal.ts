/** Work purge's real draft disposal over Postgres, for suites that purge without a composed collab domain. */
import type { Database } from "@meridian/database";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import type { WorkDraftDisposal } from "../../projects/index.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../adapters/drizzle-drafts.js";
import { createDrizzleWorkDraftDisposal } from "../adapters/drizzle-work-disposal.js";
import { createDrafts } from "../domain/drafts.js";

export function createPostgresWorkDraftDisposal(db: Database): WorkDraftDisposal {
  const { treeLists } = createTestRemovalDeps(db);
  return createDrizzleWorkDraftDisposal(db, {
    treeLists,
    drafts: createDrafts({
      store: createDrizzleDraftStore(db),
      boundary: createDrizzleDraftWriteBoundary(db, createTestWorkProjectionMutation(db)),
    }),
  });
}
