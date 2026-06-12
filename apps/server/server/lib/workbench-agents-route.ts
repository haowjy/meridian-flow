/**
 * Workbench agents catalog route core: owner-gated list of selectable agents
 * for the composer picker and Library. Delegates catalog merge rules to the
 * packages domain so HTTP handlers stay thin.
 */
import type { WorkbenchAgentsResponse } from "@meridian/contracts/agents";
import { listWorkbenchCatalogAgents } from "../domains/packages/domain/agent-catalog.js";
import type { PackageRepository } from "../domains/packages/index.js";
import { requireWorkbenchOwner, type WorkbenchRepository } from "../domains/workbenches/index.js";

export interface WorkbenchAgentsRouteDeps {
  workbenchRepo: WorkbenchRepository;
  packageRepository: PackageRepository;
}

export interface WorkbenchAgentsRouteInput {
  workbenchId: string;
  userId: string;
}

export async function handleGetWorkbenchAgentsRequest(
  deps: WorkbenchAgentsRouteDeps,
  input: WorkbenchAgentsRouteInput,
): Promise<WorkbenchAgentsResponse> {
  await requireWorkbenchOwner({ workbenches: deps.workbenchRepo }, input.workbenchId, input.userId);
  const agents = await deps.packageRepository.transaction((tx) =>
    listWorkbenchCatalogAgents(tx, input.workbenchId),
  );
  return { agents };
}
