/**
 * Workbench package update route core: owner-gated update check and apply for an
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
import { requireWorkbenchOwner, type WorkbenchRepository } from "../domains/workbenches/index.js";

export interface WorkbenchPackageUpdateRouteDeps {
  workbenchRepo: WorkbenchRepository;
  packageRepository: PackageRepository;
  marsPackageFetcher: MarsPackageFetcher;
}

export interface WorkbenchPackageUpdateRouteInput {
  workbenchId: string;
  userId: string;
  installId: string;
}

export async function handleCheckPackageUpdateRequest(
  deps: WorkbenchPackageUpdateRouteDeps,
  input: WorkbenchPackageUpdateRouteInput,
): Promise<PackageUpdateCheckResponse> {
  await requireWorkbenchOwner({ workbenches: deps.workbenchRepo }, input.workbenchId, input.userId);
  return checkPackageUpdate({
    workbenchId: input.workbenchId,
    installId: input.installId,
    repository: deps.packageRepository,
    fetcher: deps.marsPackageFetcher,
  });
}

export async function handleApplyPackageUpdateRequest(
  deps: WorkbenchPackageUpdateRouteDeps,
  input: WorkbenchPackageUpdateRouteInput,
): Promise<PackageUpdateApplyResponse> {
  await requireWorkbenchOwner({ workbenches: deps.workbenchRepo }, input.workbenchId, input.userId);
  return applyPackageUpdate({
    workbenchId: input.workbenchId,
    installId: input.installId,
    repository: deps.packageRepository,
    fetcher: deps.marsPackageFetcher,
  });
}
