/** A real draft coordinator over the database, for fixtures whose drafts can lag or be read. */
import type { Database } from "@meridian/database";
import type { createDrizzleBranchStore } from "../domains/collab/adapters/drizzle-branches.js";
import { createDrizzleDraftStore } from "../domains/collab/adapters/drizzle-drafts.js";
import { createDrizzleCollabPersistence } from "../domains/collab/adapters/drizzle-journal.js";
import { createDraftCoordinator } from "../domains/collab/domain/draft-coordinator.js";

type DraftStoreDeps = Parameters<typeof createDrizzleDraftStore>[1];

export function createTestDraftCoordinator(
  db: Database,
  deps: {
    close: DraftStoreDeps["close"];
    treeLists: DraftStoreDeps["treeLists"];
    workProjection: DraftStoreDeps["workProjection"];
    branches: ReturnType<typeof createDrizzleBranchStore>;
  },
) {
  return createDraftCoordinator({
    onAppendCommitted: () => {},
    store: createDrizzleDraftStore(db, {
      ...deps,
      live: createDrizzleCollabPersistence(db),
      onAppendSequenced: () => {},
    }),
    attemptScope: (operation) => operation(),
  });
}
