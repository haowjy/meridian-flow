/** Real removal persistence and recount for fixtures without rooms or pooled thread cores. */
import type { Database } from "@meridian/database";
import { createDrizzleDocumentRemovalCollab } from "../domains/collab/adapters/drizzle-document-removal.js";
import { createDocumentRemoval } from "../domains/context/tree/removal.js";
import { createTestWorkProjectionMutation } from "./work-projection.js";

export function createTestDocumentRemoval(db: Database) {
  return createDocumentRemoval(
    db,
    createDrizzleDocumentRemovalCollab(db, {
      workProjection: createTestWorkProjectionMutation(db),
      async closeRooms() {},
      async retire() {},
      onError(error) {
        throw error;
      },
    }),
  );
}
