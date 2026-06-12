// @ts-nocheck
/**
 * Workbench agent catalog: merges builtin and workbench-scoped agent definitions
 * into the selectable list the composer picker and Library consume. Workbench
 * agents win on slug collision (same precedence as skill resolution).
 */
import type { AgentSource, WorkbenchAgentSummary } from "@meridian/contracts/agents";
import type { PackageWriteTransaction } from "../ports/package-store.js";
import { stringAt } from "./helpers.js";
import type { AgentDefinitionRecord, PackageInstallRecord } from "./types.js";

export async function listWorkbenchCatalogAgents(
  tx: PackageWriteTransaction,
  workbenchId: string,
): Promise<WorkbenchAgentSummary[]> {
  const [builtins, workbenchAgents, packageInstalls] = await Promise.all([
    tx.listSelectableAgents(null),
    tx.listSelectableAgents(workbenchId),
    tx.listPackageInstalls(workbenchId),
  ]);

  const packageNameById = new Map(packageInstalls.map((pkg) => [pkg.id, pkg.packageName]));
  const bySlug = new Map<string, AgentDefinitionRecord>();
  for (const agent of builtins) {
    bySlug.set(agent.slug, agent);
  }
  for (const agent of workbenchAgents) {
    bySlug.set(agent.slug, agent);
  }

  return [...bySlug.values()]
    .map((agent) => toWorkbenchAgentSummary(agent, packageNameById))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function packageNameForDefinition(
  record: { sourceType: AgentDefinitionRecord["sourceType"]; packageInstallId: string | null },
  packageInstalls: PackageInstallRecord[],
): string | null {
  if (record.sourceType !== "package" || !record.packageInstallId) return null;
  return packageInstalls.find((pkg) => pkg.id === record.packageInstallId)?.packageName ?? null;
}

export function agentSourceFromRecord(
  sourceType: AgentDefinitionRecord["sourceType"],
): AgentSource {
  if (sourceType === "package") return "package";
  if (sourceType === "user") return "user";
  return "builtin";
}

function toWorkbenchAgentSummary(
  agent: AgentDefinitionRecord,
  packageNameById: Map<string, PackageInstallRecord["packageName"]>,
): WorkbenchAgentSummary {
  const source = agentSourceFromRecord(agent.sourceType);
  return {
    slug: agent.slug,
    name: stringAt(agent.meta.name) ?? agent.slug,
    description: stringAt(agent.meta.description) ?? "",
    source,
    packageName:
      source === "package" && agent.packageInstallId
        ? (packageNameById.get(agent.packageInstallId) ?? null)
        : null,
  };
}
