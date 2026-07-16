/** Compatibility seam for trail normalization and aggregate persistence. */
import type { Database } from "@meridian/database";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";

export {
  mergeTrailChanges,
  refinePushChanges,
  trailIdForOwner,
} from "./drizzle-change-trail-aggregate.js";

import { createDrizzleChangeTrailAggregateWriter } from "./drizzle-change-trail-aggregate.js";

export function createDrizzleChangeTrailPersistence(db: Database): ChangeTrailPersistence {
  return createDrizzleChangeTrailAggregateWriter(db);
}
