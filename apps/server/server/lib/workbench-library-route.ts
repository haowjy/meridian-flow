/**
 * Workbench Library route core: owner-gated full capability inventory for the
 * Library screen. Delegates merge and isEdited rules to the packages domain.
 */
import type { WorkbenchLibraryResponse } from "@meridian/contracts/agents";
import { listWorkbenchLibraryInventory } from "../domains/packages/domain/workbench-library.js";
import type { PackageRepository } from "../domains/packages/index.js";
import { requireWorkbenchOwner, type WorkbenchRepository } from "../domains/workbenches/index.js";

export interface WorkbenchLibraryRouteDeps {
  workbenchRepo: WorkbenchRepository;
  packageRepository: PackageRepository;
}

export interface WorkbenchLibraryRouteInput {
  workbenchId: string;
  userId: string;
}

export async function handleGetWorkbenchLibraryRequest(
  deps: WorkbenchLibraryRouteDeps,
  input: WorkbenchLibraryRouteInput,
): Promise<WorkbenchLibraryResponse> {
  await requireWorkbenchOwner({ workbenches: deps.workbenchRepo }, input.workbenchId, input.userId);
  return deps.packageRepository.transaction((tx) =>
    listWorkbenchLibraryInventory(tx, input.workbenchId),
  );
}
