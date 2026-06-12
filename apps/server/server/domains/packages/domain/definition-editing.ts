// @ts-nocheck
/**
 * Definition save/restore: append-only revision rows plus live record updates.
 * Saves serialize canonical file form (YAML frontmatter + body) and recompute
 * checksums; restore always appends a new revision — history is never rewritten.
 *
 * TODO(git-sync): pull = upstream commits via PackageInstallRecord.sourceCommitSha
 * into update reconciliation; push = export local revisions as commits on a branch.
 */
import type {
  AgentDefinitionDetail,
  AgentDefinitionResponse,
  DefinitionRevisionListResponse,
  DefinitionRevisionSummary,
  PatchAgentSkillLinkRequest,
  SkillDefinitionDetail,
  SkillDefinitionResponse,
  UpdateAgentDefinitionRequest,
  UpdateSkillDefinitionRequest,
} from "@meridian/contracts/agents";
import type { PackageWriteTransaction } from "../ports/package-store.js";
import { agentSourceFromRecord, packageNameForDefinition } from "./agent-catalog.js";
import { skillLinksFromMetaSkills } from "./agent-skill-links.js";
import {
  agentDefinitionContentChecksum,
  definitionContentChecksum,
  normalizeAgentMeta,
} from "./mars-source.js";
import type {
  AgentDefinitionRecord,
  AgentDefinitionRevisionRecord,
  SkillDefinitionRevisionRecord,
  SkillRecord,
} from "./types.js";

export function isDefinitionEdited(
  record: {
    body: string;
    meta: Record<string, unknown>;
    files?: SkillRecord["files"];
    config?: AgentDefinitionRecord["config"];
  },
  originalContentChecksum: string | null,
): boolean {
  if (!originalContentChecksum) return false;
  if (record.config !== undefined) {
    return (
      agentDefinitionContentChecksum({
        body: record.body,
        meta: record.meta,
        config: record.config,
      }) !== originalContentChecksum
    );
  }
  return definitionContentChecksum(record) !== originalContentChecksum;
}

export async function saveAgentDefinition(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
  input: UpdateAgentDefinitionRequest,
): Promise<AgentDefinitionResponse> {
  const agent = await requireWorkbenchAgent(tx, workbenchId, slug);
  const meta = normalizeAgentMeta(input.meta);
  const config = input.config ?? agent.config;
  const body = input.body;

  const revision = await tx.appendAgentDefinitionRevision({
    agentDefinitionId: agent.id,
    contentChecksum: agentDefinitionContentChecksum({ body, meta, config }),
    body,
    meta,
    config,
  });

  await tx.updateAgentDefinition(agent.id, {
    body,
    meta,
    config,
    originalContentChecksum: agent.originalContentChecksum,
  });

  await reconcileAgentSkillLinks(tx, workbenchId, agent.id, meta);

  const packageInstalls = await tx.listPackageInstalls(workbenchId);
  const packageName = packageNameForDefinition(agent, packageInstalls);
  const skillLinks = await buildAgentSkillLinkDetails(tx, agent.id);

  return {
    agent: toAgentDefinitionDetail(agent, {
      body,
      meta,
      config,
      packageName,
      skillLinks,
    }),
    revisionId: revision.id,
  };
}

export async function saveSkillDefinition(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
  input: UpdateSkillDefinitionRequest,
): Promise<SkillDefinitionResponse> {
  const skill = await requireWorkbenchSkill(tx, workbenchId, slug);
  const meta = input.meta;
  const body = input.body;

  const revision = await tx.appendSkillDefinitionRevision({
    skillId: skill.id,
    contentChecksum: definitionContentChecksum({ body, meta, files: skill.files }),
    body,
    meta,
    files: skill.files,
  });

  await tx.updateSkill(skill.id, {
    body,
    meta,
    files: skill.files,
    originalContentChecksum: skill.originalContentChecksum,
  });

  const packageInstalls = await tx.listPackageInstalls(workbenchId);
  const packageName = packageNameForDefinition(skill, packageInstalls);

  return {
    skill: toSkillDefinitionDetail(skill, { body, meta, files: skill.files, packageName }),
    revisionId: revision.id,
  };
}

export async function getAgentDefinition(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
): Promise<AgentDefinitionDetail> {
  const agent =
    (await tx.findAgentDefinition(workbenchId, slug)) ?? (await tx.findAgentDefinition(null, slug));
  if (!agent) {
    throw new DefinitionEditError(`Agent not found: ${slug}`);
  }
  const packageInstalls = await tx.listPackageInstalls(workbenchId);
  const packageName = packageNameForDefinition(agent, packageInstalls);
  const skillLinks = await buildAgentSkillLinkDetails(tx, agent.id);
  return toAgentDefinitionDetail(agent, {
    body: agent.body,
    meta: agent.meta,
    config: agent.config,
    packageName,
    skillLinks,
  });
}

export async function getSkillDefinition(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
): Promise<SkillDefinitionDetail> {
  const skill =
    (await tx.findSkillDefinition(workbenchId, slug)) ?? (await tx.findSkillDefinition(null, slug));
  if (!skill) {
    throw new DefinitionEditError(`Skill not found: ${slug}`);
  }
  const packageInstalls = await tx.listPackageInstalls(workbenchId);
  const packageName = packageNameForDefinition(skill, packageInstalls);
  return toSkillDefinitionDetail(skill, {
    body: skill.body,
    meta: skill.meta,
    files: skill.files,
    packageName,
  });
}

export async function listAgentDefinitionRevisions(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
): Promise<DefinitionRevisionListResponse> {
  const agent = await requireWorkbenchAgent(tx, workbenchId, slug);
  const revisions = await tx.listAgentDefinitionRevisions(agent.id);
  return { revisions: revisions.map(toRevisionSummary) };
}

export async function listSkillDefinitionRevisions(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
): Promise<DefinitionRevisionListResponse> {
  const skill = await requireWorkbenchSkill(tx, workbenchId, slug);
  const revisions = await tx.listSkillDefinitionRevisions(skill.id);
  return { revisions: revisions.map(toRevisionSummary) };
}

export async function restoreAgentDefinitionRevision(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
  revisionId: string,
): Promise<AgentDefinitionResponse> {
  const agent = await requireWorkbenchAgent(tx, workbenchId, slug);
  const revision = await requireAgentRevision(tx, agent.id, revisionId);
  return restoreAgentFromRevisionContent(tx, workbenchId, agent, revision);
}

export async function restoreAgentDefinitionOriginal(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
): Promise<AgentDefinitionResponse> {
  const agent = await requireWorkbenchAgent(tx, workbenchId, slug);
  if (!agent.originalContentChecksum) {
    throw new DefinitionEditError("This agent has no pristine package baseline to restore.");
  }
  const revisions = await tx.listAgentDefinitionRevisions(agent.id);
  const pristine = revisions.find(
    (revision) => revision.contentChecksum === agent.originalContentChecksum,
  );
  if (!pristine) {
    throw new DefinitionEditError("Pristine revision is not available for this agent.");
  }
  return restoreAgentFromRevisionContent(tx, workbenchId, agent, pristine);
}

export async function restoreSkillDefinitionRevision(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
  revisionId: string,
): Promise<SkillDefinitionResponse> {
  const skill = await requireWorkbenchSkill(tx, workbenchId, slug);
  const revision = await requireSkillRevision(tx, skill.id, revisionId);
  return restoreSkillFromRevisionContent(tx, workbenchId, skill, revision);
}

/** Immediate operational mutation — does not append a definition revision. */
export async function patchAgentSkillLink(
  tx: PackageWriteTransaction,
  workbenchId: string,
  agentSlug: string,
  skillSlug: string,
  input: PatchAgentSkillLinkRequest,
): Promise<AgentDefinitionDetail> {
  const agent = await requireWorkbenchAgent(tx, workbenchId, agentSlug);
  const skill =
    (await tx.findSkillDefinition(workbenchId, skillSlug)) ??
    (await tx.findSkillDefinition(null, skillSlug));
  if (!skill) {
    throw new DefinitionEditError(`Unknown skill slug: ${skillSlug}`);
  }

  const links = await tx.listAgentSkillLinks(agent.id);
  const link = links.find((row) => row.skillId === skill.id);
  if (!link) {
    throw new DefinitionEditError(`Skill is not linked to this agent: ${skillSlug}`);
  }

  await tx.updateAgentSkillLinkModelInvocable(agent.id, skill.id, input.modelInvocable);

  const packageInstalls = await tx.listPackageInstalls(workbenchId);
  const packageName = packageNameForDefinition(agent, packageInstalls);
  const skillLinks = await buildAgentSkillLinkDetails(tx, agent.id);
  return toAgentDefinitionDetail(agent, {
    body: agent.body,
    meta: agent.meta,
    config: agent.config,
    packageName,
    skillLinks,
  });
}

export async function restoreSkillDefinitionOriginal(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
): Promise<SkillDefinitionResponse> {
  const skill = await requireWorkbenchSkill(tx, workbenchId, slug);
  if (!skill.originalContentChecksum) {
    throw new DefinitionEditError("This skill has no pristine package baseline to restore.");
  }
  const revisions = await tx.listSkillDefinitionRevisions(skill.id);
  const pristine = revisions.find(
    (revision) => revision.contentChecksum === skill.originalContentChecksum,
  );
  if (!pristine) {
    throw new DefinitionEditError("Pristine revision is not available for this skill.");
  }
  return restoreSkillFromRevisionContent(tx, workbenchId, skill, pristine);
}

/** Append the pristine revision when a definition is first installed. */
export async function seedInitialAgentRevision(
  tx: PackageWriteTransaction,
  agent: AgentDefinitionRecord,
): Promise<void> {
  await tx.appendAgentDefinitionRevision({
    agentDefinitionId: agent.id,
    contentChecksum: agentDefinitionContentChecksum({
      body: agent.body,
      meta: agent.meta,
      config: agent.config,
    }),
    body: agent.body,
    meta: agent.meta,
    config: agent.config,
  });
}

export async function seedInitialSkillRevision(
  tx: PackageWriteTransaction,
  skill: SkillRecord,
): Promise<void> {
  await tx.appendSkillDefinitionRevision({
    skillId: skill.id,
    contentChecksum: definitionContentChecksum({
      body: skill.body,
      meta: skill.meta,
      files: skill.files,
    }),
    body: skill.body,
    meta: skill.meta,
    files: skill.files,
  });
}

export class DefinitionEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionEditError";
  }
}

async function restoreAgentFromRevisionContent(
  tx: PackageWriteTransaction,
  workbenchId: string,
  agent: AgentDefinitionRecord,
  revision: AgentDefinitionRevisionRecord,
): Promise<AgentDefinitionResponse> {
  const appended = await tx.appendAgentDefinitionRevision({
    agentDefinitionId: agent.id,
    contentChecksum: revision.contentChecksum,
    body: revision.body,
    meta: revision.meta,
    config: revision.config,
  });
  await tx.updateAgentDefinition(agent.id, {
    body: revision.body,
    meta: revision.meta,
    config: revision.config,
    originalContentChecksum: agent.originalContentChecksum,
  });
  await reconcileAgentSkillLinks(tx, workbenchId, agent.id, revision.meta);
  const packageInstalls = await tx.listPackageInstalls(workbenchId);
  const packageName = packageNameForDefinition(agent, packageInstalls);
  const skillLinks = await buildAgentSkillLinkDetails(tx, agent.id);
  return {
    agent: toAgentDefinitionDetail(agent, {
      body: revision.body,
      meta: revision.meta,
      config: revision.config,
      packageName,
      skillLinks,
    }),
    revisionId: appended.id,
  };
}

async function restoreSkillFromRevisionContent(
  tx: PackageWriteTransaction,
  workbenchId: string,
  skill: SkillRecord,
  revision: SkillDefinitionRevisionRecord,
): Promise<SkillDefinitionResponse> {
  await tx.updateSkill(skill.id, {
    body: revision.body,
    meta: revision.meta,
    files: revision.files,
    originalContentChecksum: skill.originalContentChecksum,
  });
  const appended = await tx.appendSkillDefinitionRevision({
    skillId: skill.id,
    contentChecksum: revision.contentChecksum,
    body: revision.body,
    meta: revision.meta,
    files: revision.files,
  });
  const packageInstalls = await tx.listPackageInstalls(workbenchId);
  const packageName = packageNameForDefinition(skill, packageInstalls);
  return {
    skill: toSkillDefinitionDetail(skill, {
      body: revision.body,
      meta: revision.meta,
      files: revision.files,
      packageName,
    }),
    revisionId: appended.id,
  };
}

async function requireWorkbenchAgent(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
): Promise<AgentDefinitionRecord> {
  const agent = await tx.findAgentDefinition(workbenchId, slug);
  if (!agent) {
    throw new DefinitionEditError(`Agent is not editable in this workbench: ${slug}`);
  }
  return agent;
}

async function requireWorkbenchSkill(
  tx: PackageWriteTransaction,
  workbenchId: string,
  slug: string,
): Promise<SkillRecord> {
  const skill = await tx.findSkillDefinition(workbenchId, slug);
  if (!skill) {
    throw new DefinitionEditError(`Skill is not editable in this workbench: ${slug}`);
  }
  return skill;
}

async function requireAgentRevision(
  tx: PackageWriteTransaction,
  agentDefinitionId: string,
  revisionId: string,
): Promise<AgentDefinitionRevisionRecord> {
  const revision = await tx.findAgentDefinitionRevision(revisionId);
  if (!revision || revision.agentDefinitionId !== agentDefinitionId) {
    throw new DefinitionEditError(`Revision not found: ${revisionId}`);
  }
  return revision;
}

async function requireSkillRevision(
  tx: PackageWriteTransaction,
  skillId: string,
  revisionId: string,
): Promise<SkillDefinitionRevisionRecord> {
  const revision = await tx.findSkillDefinitionRevision(revisionId);
  if (!revision || revision.skillId !== skillId) {
    throw new DefinitionEditError(`Revision not found: ${revisionId}`);
  }
  return revision;
}

async function reconcileAgentSkillLinks(
  tx: PackageWriteTransaction,
  workbenchId: string,
  agentDefinitionId: string,
  meta: AgentDefinitionRecord["meta"],
): Promise<void> {
  const existingLinks = await tx.listAgentSkillLinks(agentDefinitionId);
  const nextLinks = await skillLinksFromMetaSkills(
    tx,
    workbenchId,
    agentDefinitionId,
    meta,
    existingLinks,
  );
  await tx.replaceAgentSkillLinks(agentDefinitionId, nextLinks);
}

async function buildAgentSkillLinkDetails(
  tx: PackageWriteTransaction,
  agentDefinitionId: string,
): Promise<AgentDefinitionDetail["skillLinks"]> {
  const links = await tx.listAgentSkillLinks(agentDefinitionId);
  const details: AgentDefinitionDetail["skillLinks"] = [];
  for (const link of links) {
    const skill = await tx.findSkillById(link.skillId);
    if (!skill) continue;
    details.push({
      skillSlug: skill.slug,
      ordinal: link.ordinal ?? 0,
      modelInvocable: link.modelInvocable ?? null,
      userInvocable: link.userInvocable ?? null,
    });
  }
  return details.sort((left, right) => left.ordinal - right.ordinal);
}

function toAgentDefinitionDetail(
  agent: AgentDefinitionRecord,
  current: {
    body: string;
    meta: AgentDefinitionRecord["meta"];
    config: AgentDefinitionRecord["config"];
    packageName: string | null;
    skillLinks: AgentDefinitionDetail["skillLinks"];
  },
): AgentDefinitionDetail {
  const contentChecksum = agentDefinitionContentChecksum({
    body: current.body,
    meta: current.meta,
    config: current.config,
  });
  return {
    slug: agent.slug,
    body: current.body,
    meta: current.meta,
    config: current.config,
    source: agentSourceFromRecord(agent.sourceType),
    packageName: current.packageName,
    originalContentChecksum: agent.originalContentChecksum,
    contentChecksum,
    isEdited: isDefinitionEdited(
      { body: current.body, meta: current.meta, config: current.config },
      agent.originalContentChecksum,
    ),
    skillLinks: current.skillLinks,
  };
}

function toSkillDefinitionDetail(
  skill: SkillRecord,
  current: {
    body: string;
    meta: SkillRecord["meta"];
    files: SkillRecord["files"];
    packageName: string | null;
  },
): SkillDefinitionDetail {
  const contentChecksum = definitionContentChecksum({
    body: current.body,
    meta: current.meta,
    files: current.files,
  });
  return {
    slug: skill.slug,
    body: current.body,
    meta: current.meta,
    files: current.files,
    source: agentSourceFromRecord(skill.sourceType),
    packageName: current.packageName,
    originalContentChecksum: skill.originalContentChecksum,
    contentChecksum,
    isEdited: isDefinitionEdited(
      { body: current.body, meta: current.meta, files: current.files },
      skill.originalContentChecksum,
    ),
  };
}

function toRevisionSummary(
  revision: AgentDefinitionRevisionRecord | SkillDefinitionRevisionRecord,
): DefinitionRevisionSummary {
  return {
    id: revision.id,
    contentChecksum: revision.contentChecksum,
    createdAt: revision.createdAt,
  };
}
