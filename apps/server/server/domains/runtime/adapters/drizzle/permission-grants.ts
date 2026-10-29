/** Drizzle adapter for project-scoped action grants. */
import { projectActionGrants } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDb,
} from "../../../threads/adapters/drizzle/repositories.js";
import type { PermissionGrantStore } from "../../loop/permissions/permission-grants.js";

export function createDrizzlePermissionGrantStore(db: DrizzleDb): PermissionGrantStore {
  return {
    async has(projectId, action) {
      const [row] = await currentDrizzleDb(db)
        .select({ action: projectActionGrants.action })
        .from(projectActionGrants)
        .where(
          and(eq(projectActionGrants.projectId, projectId), eq(projectActionGrants.action, action)),
        )
        .limit(1);
      return row !== undefined;
    },
    async grant(projectId, action) {
      await currentDrizzleDb(db)
        .insert(projectActionGrants)
        .values({ projectId, action })
        .onConflictDoNothing();
    },
  };
}
