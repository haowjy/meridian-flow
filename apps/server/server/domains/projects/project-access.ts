import type {
  Project,
  ProjectAvailabilityCode,
  ProjectAvailabilityDetails,
} from "@meridian/contracts/projects";
import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { throwHttpInterrupt } from "../../shared/interrupt-boundary.js";
import type { ProjectRepository } from "./ports/project-repository.js";

export type RequireProjectOwnerOptions = {
  includeSoftDeleted?: boolean;
};

export async function requireProjectOwner(
  repos: { projects: Pick<ProjectRepository, "findById"> },
  projectId: string,
  userId: UserId,
  options?: RequireProjectOwnerOptions,
): Promise<Project> {
  const project = await repos.projects.findById(projectId);
  if (!project || project.userId !== userId) {
    throw createError({ statusCode: 404, message: "Project not found" });
  }
  if (!options?.includeSoftDeleted && project.deletedAt) {
    throwHttpInterrupt(
      {
        code: "project_deleted" satisfies ProjectAvailabilityCode,
        message: "Project not found",
        retryable: false,
        source: "system",
        details: { authenticatedUserId: userId } satisfies ProjectAvailabilityDetails,
      },
      404,
    );
  }
  return project;
}
