/**
 * Project authorization helper: requireProjectOwner loads a project and asserts
 * the caller owns it, throwing an h3 error otherwise. Owns the project ownership
 * gate shared by route handlers; depends inward on the ProjectRepository port.
 */

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
  /** When true, soft-deleted projects are returned (for idempotent DELETE). */
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
        // Keep the generic message: SSR and existing unavailable paths use it.
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
