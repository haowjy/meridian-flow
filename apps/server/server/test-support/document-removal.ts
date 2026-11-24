import type { Database } from "@meridian/database";
import { createDrizzleTreeListStore } from "../domains/context/adapters/drizzle-tree-list-store.js";
import { createTrashRemovals } from "../domains/context/adapters/trash-removals.js";

export function createTestRemovalDeps(db: Database) {
  const treeLists = createDrizzleTreeListStore({ db });
  return { treeLists, removals: createTrashRemovals(db) };
}
