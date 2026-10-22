/** The real removal kernel for fixtures without rooms or pooled thread cores: closes retire nothing. */
import type { Database } from "@meridian/database";
import { createDrizzleDocumentRemovalCollab } from "../domains/collab/adapters/drizzle-document-removal.js";
import {
  createDraftClose,
  type DraftClose,
} from "../domains/collab/adapters/drizzle-draft-close.js";
import type { DocumentRemoval } from "../domains/context/ports/document-removal.js";
import { createDocumentRemoval } from "../domains/context/tree/removal.js";
import type { WorkProjectionMutation } from "../domains/projects/index.js";
import { createTestWorkProjectionMutation } from "./work-projection.js";

/** The closer and the kernel over it, as the composition root builds them. */
export function createTestRemovalDeps(
  db: Database,
  workProjection: Pick<
    WorkProjectionMutation,
    "recountAfterCommit"
  > = createTestWorkProjectionMutation(db),
): { draftClose: DraftClose; documentRemoval: DocumentRemoval } {
  const draftClose = createDraftClose();
  return {
    draftClose,
    documentRemoval: createDocumentRemoval(db, {
      collab: createDrizzleDocumentRemovalCollab(db, draftClose),
      workProjection,
    }),
  };
}

export function createTestDocumentRemoval(db: Database): DocumentRemoval {
  return createTestRemovalDeps(db).documentRemoval;
}
