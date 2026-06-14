/**
 * Project package update route core: owner-gated update check and apply for an
 * installed package, honoring pristine-vs-edited reconciliation semantics.
 */
import type {
  PackageUpdateApplyResponse,
  PackageUpdateCheckResponse,
} from "@meridian/contracts/agents";

import {
  applyPackageUpdate,
  checkPackageUpdate,
  type MarsPackageFetcher,
  type PackageRepository,
} from "../domains/packages/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";

export interface ProjectPackageUpdateRouteDeps {
  projectRepo: ProjectRepository;
  packageRepository: PackageRepository;
  marsPackageFetcher: MarsPackageFetcher;
}

export interface ProjectPackageUpdateRouteInput {
  projectId: string;
  userId: string;
  installId: string;
}

export async function handleCheckPackageUpdateRequest(
  deps: ProjectPackageUpdateRouteDeps,
  input: ProjectPackageUpdateRouteInput,
): Promise<PackageUpdateCheckResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  return checkPackageUpdate({
    projectId: input.projectId,
    installId: input.installId,
    repository: deps.packageRepository,
    fetcher: deps.marsPackageFetcher,
  });
}

export async function handleApplyPackageUpdateRequest(
  deps: ProjectPackageUpdateRouteDeps,
  input: ProjectPackageUpdateRouteInput,
): Promise<PackageUpdateApplyResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  return applyPackageUpdate({
    projectId: input.projectId,
    installId: input.installId,
    repository: deps.packageRepository,
    fetcher: deps.marsPackageFetcher,
  });
}
