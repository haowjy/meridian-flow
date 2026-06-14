// @ts-nocheck
/**
 * Project preferences persistence port: stores the authenticated user's UI defaults for one project.
 * The boundary is intentionally small: reads return the contract default when absent, and upserts merge partial updates into the current/default value.
 */
import type {
  ProjectPreferences,
  UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";

export interface ProjectPreferencesRepository {
  read(userId: UserId, projectId: ProjectId): Promise<ProjectPreferences>;
  upsert(
    userId: UserId,
    projectId: ProjectId,
    input: UpdateProjectPreferencesRequest,
  ): Promise<ProjectPreferences>;
}
