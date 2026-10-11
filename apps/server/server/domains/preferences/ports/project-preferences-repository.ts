/**
 * Project preferences persistence port for the runtime auto-resume policy.
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
