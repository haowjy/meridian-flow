/** Drizzle adapter for immutable prompt bake rows. */

import type { PromptBakeId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import type { PromptBakeRepository } from "../../ports/repositories.js";
import { mapPromptBake } from "./mappers.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

export function createDrizzlePromptBakeRepository(db: DrizzleDatabase): PromptBakeRepository {
  return {
    async create(input) {
      const [row] = await currentDrizzleDb(db).insert(schema.promptBakes).values(input).returning();
      if (!row) throw new Error("Failed to create prompt bake");
      return mapPromptBake(row);
    },
    async findById(id: PromptBakeId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(schema.promptBakes)
        .where(eq(schema.promptBakes.id, id));
      return row ? mapPromptBake(row) : null;
    },
  };
}
