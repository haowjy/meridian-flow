/**
 * Project Library inventory: full agent/skill/package summaries for the
 * Library screen. Distinct from the selectable catalog — includes disabled
 * agents and unlinked skills because the Library is the authoring surface.
 */
import type {
  LibraryAgentSummary,
  LibraryPackageSummary,
  LibrarySkillSummary,
  ProjectLibraryResponse,
} from "@meridian/contracts/agents";
import type { PackageWriteTransaction } from "../ports/package-store.js";
import { agentSourceFromRecord, packageNameForDefinition } from "./agent-catalog.js";
import { isDefinitionEdited } from "./definition-editing.js";
import { stringAt } from "./helpers.js";
import { agentDefinitionContentChecksum } from "./mars-source.js";
import type { AgentDefinitionRecord, PackageInstallRecord, SkillRecord } from "./types.js";

export async function listProjectLibraryInventory(
  tx: PackageWriteTransaction,
  projectId: string,
): Promise<ProjectLibraryResponse> {
  const [builtinAgents, projectAgents, builtinSkills, projectSkills, packageInstalls] =
    await Promise.all([
      tx.listProjectAgentDefinitions(null),
      tx.listProjectAgentDefinitions(projectId),
      tx.listProjectSkillDefinitions(null),
      tx.listProjectSkillDefinitions(projectId),
      tx.listPackageInstalls(projectId),
    ]);

  const agentsBySlug = new Map<string, AgentDefinitionRecord>();
  for (const agent of builtinAgents) agentsBySlug.set(agent.slug, agent);
  for (const agent of projectAgents) agentsBySlug.set(agent.slug, agent);

  const skillsBySlug = new Map<string, SkillRecord>();
  for (const skill of builtinSkills) skillsBySlug.set(skill.slug, skill);
  for (const skill of projectSkills) skillsBySlug.set(skill.slug, skill);

  const agents = [...agentsBySlug.values()]
    .map((agent) => toLibraryAgentSummary(agent, packageInstalls))
    .sort((left, right) => left.name.localeCompare(right.name));

  const skills = [...skillsBySlug.values()]
    .map((skill) => toLibrarySkillSummary(skill, packageInstalls))
    .sort((left, right) => left.description.localeCompare(right.description));

  const packages = await Promise.all(
    packageInstalls.map(async (pkg) => toLibraryPackageSummary(tx, pkg)),
  );

  return {
    agents,
    skills,
    packages: packages.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function toLibraryAgentSummary(
  agent: AgentDefinitionRecord,
  packageInstalls: PackageInstallRecord[],
): LibraryAgentSummary {
  const source = agentSourceFromRecord(agent.sourceType);
  return {
    slug: agent.slug,
    name: stringAt(agent.meta.name) ?? agent.slug,
    description: stringAt(agent.meta.description) ?? "",
    source,
    packageName: packageNameForDefinition(agent, packageInstalls),
    enabled: agent.enabled,
    isEdited: isAgentLibraryEdited(agent),
  };
}

function toLibrarySkillSummary(
  skill: SkillRecord,
  packageInstalls: PackageInstallRecord[],
): LibrarySkillSummary {
  const source = agentSourceFromRecord(skill.sourceType);
  return {
    slug: skill.slug,
    description: stringAt(skill.meta.description) ?? "",
    source,
    packageName: packageNameForDefinition(skill, packageInstalls),
    isEdited: isDefinitionEdited(
      { body: skill.body, meta: skill.meta, files: skill.files },
      skill.originalContentChecksum,
    ),
  };
}

async function toLibraryPackageSummary(
  tx: PackageWriteTransaction,
  pkg: PackageInstallRecord,
): Promise<LibraryPackageSummary> {
  const [agents, skills] = await Promise.all([
    tx.listPackageAgents(pkg.id),
    tx.listPackageSkills(pkg.id),
  ]);
  return {
    slug: pkg.packageName,
    installId: pkg.id,
    name: pkg.packageName,
    version: pkg.version ?? null,
    agentCount: agents.length,
    skillCount: skills.length,
  };
}

function isAgentLibraryEdited(agent: AgentDefinitionRecord): boolean {
  if (!agent.originalContentChecksum) return false;
  return (
    agentDefinitionContentChecksum({
      body: agent.body,
      meta: agent.meta,
      config: agent.config,
    }) !== agent.originalContentChecksum
  );
}
