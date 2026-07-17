/** Resolves the single Work that currently backs a project for one writer. */
import type { Project } from "@meridian/contracts/projects";
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { WorkRepository } from "./ports/work-repository.js";

export async function resolveDefaultWork(
  deps: { works: WorkRepository },
  user: { userId: UserId },
  project: Project,
): Promise<WorkId> {
  if (project.userId !== user.userId) {
    throw new Error("Cannot resolve a default Work for a project the user does not own");
  }

  const projectWorks = await deps.works.listByProject(project.id);
  if (projectWorks.length === 1) return projectWorks[0].id;
  if (projectWorks.length === 0) {
    return (await deps.works.ensureDefaultForProject(project.id)).id;
  }

  // Default selection policy deliberately does not exist yet. Keeping the
  // invariant loud prevents repository ordering from becoming accidental policy.
  throw new Error(`Project ${project.id} has ${projectWorks.length} active Works; expected one`);
}
