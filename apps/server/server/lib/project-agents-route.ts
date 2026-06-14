/**
 * Project agents catalog route core: owner-gated list of selectable agents
 * for the composer picker and Library. Delegates catalog merge rules to the
 * packages domain so HTTP handlers stay thin.
 */
import type { ProjectAgentsResponse } from "@meridian/contracts/agents";
import { listProjectCatalogAgents } from "../domains/packages/domain/agent-catalog.js";
import type { PackageRepository } from "../domains/packages/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";

export interface ProjectAgentsRouteDeps {
  projectRepo: ProjectRepository;
  packageRepository: PackageRepository;
  seedDefaultPackagesForProject?: (projectId: string) => Promise<void>;
}

export interface ProjectAgentsRouteInput {
  projectId: string;
  userId: string;
}

export async function handleGetProjectAgentsRequest(
  deps: ProjectAgentsRouteDeps,
  input: ProjectAgentsRouteInput,
): Promise<ProjectAgentsResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  await deps.seedDefaultPackagesForProject?.(input.projectId);
  const agents = await deps.packageRepository.transaction((tx) =>
    listProjectCatalogAgents(tx, input.projectId),
  );
  return { agents };
}
