/**
 * Builtin agents catalog route core: authed list of enabled primary builtins
 * for Home before a workbench exists.
 */
import type { WorkbenchAgentsResponse } from "@meridian/contracts/agents";
import { listBuiltinCatalogAgents } from "../domains/packages/domain/agent-catalog.js";
import type { PackageRepository } from "../domains/packages/index.js";

export interface BuiltinAgentsRouteDeps {
  packageRepository: PackageRepository;
}

export async function handleGetBuiltinAgentsRequest(
  deps: BuiltinAgentsRouteDeps,
): Promise<WorkbenchAgentsResponse> {
  const agents = await deps.packageRepository.transaction((tx) => listBuiltinCatalogAgents(tx));
  return { agents };
}
