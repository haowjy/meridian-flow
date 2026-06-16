/**
 * Project agent catalog: merges builtin and project-scoped agent definitions
 * into the selectable list the composer picker and Library consume. Project
 * agents win on slug collision (same precedence as skill resolution).
 */
import type { AgentSource, ProjectAgentSummary } from "@meridian/contracts/agents";
import type { PackageWriteTransaction } from "../ports/package-store.js";
import { resolveLaunchAgentPackageDir } from "./default-package-seeding.js";
import { stringAt } from "./helpers.js";
import { parseMarsPackageSource } from "./mars-source.js";
import type {
  AgentDefinitionRecord,
  PackageInstallRecord,
  ParsedAgentDefinition,
} from "./types.js";

const LAUNCH_AGENT_SLUGS = new Set(["setup", "muse", "spark", "writer", "none"]);

export async function listBuiltinCatalogAgents(
  tx: PackageWriteTransaction,
): Promise<ProjectAgentSummary[]> {
  const builtins = await tx.listSelectableAgents(null);
  const agents = builtins
    .filter((agent) => agent.sourceType === "builtin")
    .map((agent) => toProjectAgentSummary(agent, new Map()));
  const launchAgents = agents.filter((agent) => LAUNCH_AGENT_SLUGS.has(agent.slug));
  if (launchAgents.length === LAUNCH_AGENT_SLUGS.size) return sortCatalogAgents(launchAgents);

  return sortCatalogAgents(await listLaunchPackageCatalogAgents());
}

async function listLaunchPackageCatalogAgents(): Promise<ProjectAgentSummary[]> {
  const source = await parseMarsPackageSource(await resolveLaunchAgentPackageDir());
  return source.agents
    .filter(
      (agent) => LAUNCH_AGENT_SLUGS.has(agent.slug) && stringAt(agent.meta.mode) !== "subagent",
    )
    .map((agent) => parsedAgentToBuiltinSummary(agent));
}

function sortCatalogAgents(agents: ProjectAgentSummary[]): ProjectAgentSummary[] {
  return agents.sort((left, right) => left.name.localeCompare(right.name));
}

function parsedAgentToBuiltinSummary(agent: ParsedAgentDefinition): ProjectAgentSummary {
  return {
    slug: agent.slug,
    name: stringAt(agent.meta.name) ?? agent.slug,
    description: stringAt(agent.meta.description) ?? "",
    source: "builtin",
    packageName: null,
  };
}

export async function listProjectCatalogAgents(
  tx: PackageWriteTransaction,
  projectId: string,
): Promise<ProjectAgentSummary[]> {
  const [builtins, projectAgents, packageInstalls] = await Promise.all([
    tx.listSelectableAgents(null),
    tx.listSelectableAgents(projectId),
    tx.listPackageInstalls(projectId),
  ]);

  const packageNameById = new Map(packageInstalls.map((pkg) => [pkg.id, pkg.packageName]));
  const bySlug = new Map<string, AgentDefinitionRecord>();
  for (const agent of builtins) {
    bySlug.set(agent.slug, agent);
  }
  for (const agent of projectAgents) {
    bySlug.set(agent.slug, agent);
  }

  return [...bySlug.values()]
    .map((agent) => toProjectAgentSummary(agent, packageNameById))
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

function toProjectAgentSummary(
  agent: AgentDefinitionRecord,
  packageNameById: Map<string, PackageInstallRecord["packageName"]>,
): ProjectAgentSummary {
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
