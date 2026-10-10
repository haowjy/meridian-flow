/** Work purge's real draft disposal over Postgres, for suites that purge without a composed collab domain. */
import type { Database } from "@meridian/database";
import { createDrizzleContextCatalog } from "../../context/index.js";
import type { WorkDraftDisposal } from "../../projects/index.js";
import { createDrizzleWorkDraftDisposal } from "../adapters/drizzle-draft-discard.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../adapters/drizzle-drafts.js";
import { createBranchCriticalSections } from "../domain/branch-critical-sections.js";
import { createDrafts } from "../domain/drafts.js";

export function createPostgresWorkDraftDisposal(db: Database): WorkDraftDisposal {
  return createDrizzleWorkDraftDisposal(db, {
    drafts: createDrafts({
      store: createDrizzleDraftStore(db),
      boundary: createDrizzleDraftWriteBoundary(db),
    }),
    criticalSections: createBranchCriticalSections(),
    catalog: createDrizzleContextCatalog(db),
  });
}
