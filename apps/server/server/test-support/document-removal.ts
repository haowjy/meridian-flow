/** What collab's composition needs besides a database, for fixtures without rooms: the project tree's lists and the removal lookup. */
import type { Database } from "@meridian/database";
import { createDrizzleJournal } from "../domains/collab/adapters/drizzle-journal.js";
import { createDrizzleTreeListStore } from "../domains/context/adapters/drizzle-tree-list-store.js";
import { createTrashRemovals } from "../domains/context/adapters/trash-removals.js";

export function createTestRemovalDeps(db: Database) {
  const treeLists = createDrizzleTreeListStore({ db, journal: createDrizzleJournal(db) });
  return { treeLists, removals: createTrashRemovals(db) };
}
