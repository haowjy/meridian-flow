/** Per-writer favorite persistence for Project chat rows. */
import * as schema from "@meridian/database/schema";
import type { ThreadUserStateRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

export function createDrizzleThreadUserStateRepository(
  db: DrizzleDatabase,
): ThreadUserStateRepository {
  return {
    async update(input) {
      const [row] = await currentDrizzleDb(db)
        .insert(schema.threadUserState)
        .values(input)
        .onConflictDoUpdate({
          target: [schema.threadUserState.threadId, schema.threadUserState.userId],
          set: { isFavorite: input.isFavorite },
        })
        .returning({
          threadId: schema.threadUserState.threadId,
          isFavorite: schema.threadUserState.isFavorite,
        });
      if (!row) throw new Error(`Failed to update thread user state: ${input.threadId}`);
      return row;
    },
  };
}
