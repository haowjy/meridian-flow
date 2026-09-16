/**
 * Project package update route core: owner-gated update check and apply for an
 * installed package, honoring pristine-vs-edited reconciliation semantics.
 */
import type {
  PackageUpdateApplyResponse,
  PackageUpdateCheckResponse,
} from "@meridian/contracts/agents";

import {
  type AgentRevisionStore,
  applyPackageUpdate,
  checkPackageUpdate,
  type MarsPackageFetcher,
} from "../domains/packages/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";

export interface ProjectPackageUpdateRouteDeps {
  projectRepo: ProjectRepository;
  agentRevisions: AgentRevisionStore;
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
    userId: input.userId,
    installId: input.installId,
    store: deps.agentRevisions,
    fetcher: deps.marsPackageFetcher,
  });
}

export async function handleApplyPackageUpdateRequest(
  deps: ProjectPackageUpdateRouteDeps,
  input: ProjectPackageUpdateRouteInput,
): Promise<PackageUpdateApplyResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  return applyPackageUpdate({
    userId: input.userId,
    installId: input.installId,
    store: deps.agentRevisions,
    fetcher: deps.marsPackageFetcher,
  });
}
