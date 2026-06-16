/**
 * Project authorization helper: requireProjectOwner loads a project and asserts
 * the caller owns it, throwing an h3 error otherwise. Owns the project ownership
 * gate shared by route handlers; depends inward on the ProjectRepository port.
 */

import type { Project } from "@meridian/contracts/projects";
import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { ProjectRepository } from "./ports/project-repository.js";

export type RequireProjectOwnerOptions = {
  /** When true, soft-deleted projects are returned (for idempotent DELETE). */
  includeSoftDeleted?: boolean;
};

export async function requireProjectOwner(
  repos: { projects: ProjectRepository },
  projectId: string,
  userId: UserId,
  options?: RequireProjectOwnerOptions,
): Promise<Project> {
  const project = await repos.projects.findById(projectId);
  if (!project) {
    throw createError({ statusCode: 404, message: "Project not found" });
  }
  if (project.userId !== userId) {
    throw createError({ statusCode: 404, message: "Project not found" });
  }
  if (!options?.includeSoftDeleted && project.deletedAt) {
    throw createError({ statusCode: 404, message: "Project not found" });
  }
  return project;
}
