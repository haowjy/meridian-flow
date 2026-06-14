/**
 * Project Library route core: owner-gated full capability inventory for the
 * Library screen. Delegates merge and isEdited rules to the packages domain.
 */
import type { ProjectLibraryResponse } from "@meridian/contracts/agents";
import { listProjectLibraryInventory } from "../domains/packages/domain/project-library.js";
import type { PackageRepository } from "../domains/packages/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";

export interface ProjectLibraryRouteDeps {
  projectRepo: ProjectRepository;
  packageRepository: PackageRepository;
}

export interface ProjectLibraryRouteInput {
  projectId: string;
  userId: string;
}

export async function handleGetProjectLibraryRequest(
  deps: ProjectLibraryRouteDeps,
  input: ProjectLibraryRouteInput,
): Promise<ProjectLibraryResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  return deps.packageRepository.transaction((tx) =>
    listProjectLibraryInventory(tx, input.projectId),
  );
}
