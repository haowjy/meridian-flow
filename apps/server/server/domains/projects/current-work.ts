/** Resolves a writer's current Work without turning repository order into policy. */
import type { Project } from "@meridian/contracts/projects";
import type { UserId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { ProjectPreferencesRepository } from "../preferences/index.js";
import type { WorkRepository } from "./ports/work-repository.js";

export interface ResolveCurrentWorkDeps {
  works: WorkRepository;
  preferences: ProjectPreferencesRepository;
}

export async function resolveCurrentWork(
  deps: ResolveCurrentWorkDeps,
  user: { userId: UserId },
  project: Project,
): Promise<Work> {
  if (project.userId !== user.userId) {
    throw new Error("Cannot resolve current Work for a project the user does not own");
  }

  let preferredId = await deps.preferences.getCurrentWorkId(user.userId, project.id);
  for (;;) {
    if (preferredId) {
      const preferred = await deps.works.findById(preferredId);
      if (preferred && !preferred.deletedAt && preferred.projectId === project.id) return preferred;
    }

    const [active] = await deps.works.listByProject(project.id, { status: "active" });
    const [archived] = active
      ? []
      : await deps.works.listByProject(project.id, { status: "archived" });
    const fallback =
      active ?? archived ?? (await deps.works.ensureDefaultForProject(project.id, project.name));
    const persisted = await deps.preferences.setCurrentWorkIdIfUnchanged(
      user.userId,
      project.id,
      preferredId,
      fallback.id,
    );
    if (persisted) return fallback;
    preferredId = await deps.preferences.getCurrentWorkId(user.userId, project.id);
  }
}
