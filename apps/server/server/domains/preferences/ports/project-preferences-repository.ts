/**
 * Project preferences persistence port for project UI settings plus the internal
 * omitted-new-chat fallback pointer. Only compare-and-set repair can write that pointer.
 */
import type {
  ProjectPreferences,
  UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";
import type { ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";

export interface ProjectPreferencesRepository {
  read(userId: UserId, projectId: ProjectId): Promise<ProjectPreferences>;
  upsert(
    userId: UserId,
    projectId: ProjectId,
    input: UpdateProjectPreferencesRequest,
  ): Promise<ProjectPreferences>;
  getNewChatFallbackWorkId(userId: UserId, projectId: ProjectId): Promise<WorkId | null>;
  repairNewChatFallbackWorkId(
    userId: UserId,
    projectId: ProjectId,
    expectedWorkId: WorkId | null,
    workId: WorkId,
  ): Promise<boolean>;
}
