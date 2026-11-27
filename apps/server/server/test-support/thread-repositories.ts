import type { Database } from "@meridian/database";
import { createDrizzleLineageScratchLifecycle } from "../domains/context/index.js";
import { createDrizzleRepositories } from "../domains/threads/adapters/drizzle/repositories.js";
import type { InternalThreadRepositories } from "../domains/threads/ports/repositories.js";

export function createDrizzleRepositoriesForTest(db: Database): InternalThreadRepositories {
  return createDrizzleRepositories(db, null, createDrizzleLineageScratchLifecycle(db));
}
