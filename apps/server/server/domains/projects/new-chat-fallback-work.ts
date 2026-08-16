/** Resolves the internal Work fallback used only when a new chat omits workId. */
import type { Project } from "@meridian/contracts/projects";
import type { UserId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { ProjectPreferencesRepository } from "../preferences/index.js";
import type { WorkRepository } from "./ports/work-repository.js";

export interface ResolveNewChatFallbackWorkDeps {
  works: WorkRepository;
  preferences: ProjectPreferencesRepository;
}

export async function resolveNewChatFallbackWork(
  deps: ResolveNewChatFallbackWorkDeps,
  user: { userId: UserId },
  project: Project,
): Promise<Work> {
  if (project.userId !== user.userId) {
    throw new Error("Cannot resolve new-chat fallback Work for a project the user does not own");
  }

  let fallbackId = await deps.preferences.getNewChatFallbackWorkId(user.userId, project.id);
  for (;;) {
    if (fallbackId) {
      const savedFallback = await deps.works.findById(fallbackId);
      if (savedFallback && !savedFallback.deletedAt && savedFallback.projectId === project.id)
        return savedFallback;
    }

    const [active] = await deps.works.listByProject(project.id, { status: "active" });
    const [archived] = active
      ? []
      : await deps.works.listByProject(project.id, { status: "archived" });
    const fallback =
      active ?? archived ?? (await deps.works.ensureDefaultForProject(project.id, project.name));
    const persisted = await deps.preferences.repairNewChatFallbackWorkId(
      user.userId,
      project.id,
      fallbackId,
      fallback.id,
    );
    if (persisted) return fallback;
    fallbackId = await deps.preferences.getNewChatFallbackWorkId(user.userId, project.id);
  }
}
