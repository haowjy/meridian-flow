/**
 * Home project route core: resolves the authenticated user's landing project.
 * Prefers last-active when still owned and not deleted; otherwise the personal project.
 */
import type { HomeProjectResponse } from "@meridian/contracts/protocol";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type {
  ProjectBootstrapRepository,
  ProjectRepository,
  UserRepository,
} from "../domains/projects/index.js";

export interface HomeProjectRouteDeps {
  users: UserRepository;
  projects: ProjectBootstrapRepository;
  projectRepo: ProjectRepository;
}

export async function handleGetHomeProjectRequest(
  deps: HomeProjectRouteDeps,
  userId: UserId,
): Promise<HomeProjectResponse> {
  const lastActiveProjectId = await deps.users.getLastActiveProjectId(userId);
  if (lastActiveProjectId) {
    const project = await deps.projectRepo.findById(lastActiveProjectId);
    if (project && project.userId === userId && project.deletedAt == null) {
      return { projectId: lastActiveProjectId };
    }
  }

  const personalProjectId = await deps.projects.findPersonalProjectId(userId);
  if (personalProjectId) return { projectId: personalProjectId };

  const bootstrap = await deps.projects.ensureDefaultBootstrap(userId);
  return { projectId: bootstrap.projectId as ProjectId };
}
