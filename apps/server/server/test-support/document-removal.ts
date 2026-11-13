/**
 * What collab's composition needs besides a database, for fixtures without rooms or pooled
 * thread cores: a closer that retires nothing, the project tree's lists, and the removal lookup.
 */
import type { Database } from "@meridian/database";
import { createDraftClose } from "../domains/collab/adapters/drizzle-draft-close.js";
import { createDrizzleJournal } from "../domains/collab/adapters/drizzle-journal.js";
import { createDrizzleTreeListStore } from "../domains/context/adapters/drizzle-tree-list-store.js";
import type { DocumentRemovals } from "../domains/context/ports/document-removal.js";

export function createTestRemovalDeps(db: Database) {
  const removals: DocumentRemovals = { lookup: async () => new Map() };
  return {
    draftClose: createDraftClose(),
    treeLists: createDrizzleTreeListStore({ db, journal: createDrizzleJournal(db) }),
    removals,
  };
}
