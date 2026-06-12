// @ts-nocheck
// Package repository port: the active persistence boundary for Mars package installs.
import type {
  AgentDefinitionRecord,
  AgentDefinitionRevisionRecord,
  AgentSkillLinkRecord,
  PackageInstallRecord,
  ResolvedPackageContext,
  SkillDefinitionRevisionRecord,
  SkillRecord,
  UserInstalledSkillRecord,
} from "../domain/types.js";

export interface PackageWriteTransaction {
  findPackageInstall(
    workbenchId: string,
    packageName: string,
  ): Promise<PackageInstallRecord | undefined>;
  createPackageInstall(input: Omit<PackageInstallRecord, "id">): Promise<PackageInstallRecord>;
  updatePackageInstall(id: string, input: Partial<Omit<PackageInstallRecord, "id">>): Promise<void>;

  findAgentBySlug(
    workbenchId: string | null,
    slug: string,
  ): Promise<AgentDefinitionRecord | undefined>;
  findAgentDefinition(
    workbenchId: string | null,
    slug: string,
  ): Promise<AgentDefinitionRecord | undefined>;
  /** Slug lookup including disabled/retired rows — install collision checks only. */
  findAgentDefinitionAnyState(
    workbenchId: string | null,
    slug: string,
  ): Promise<AgentDefinitionRecord | undefined>;
  listSelectableAgents(workbenchId: string | null): Promise<AgentDefinitionRecord[]>;
  /** Full agent inventory for a scope — includes disabled and subagents. */
  listWorkbenchAgentDefinitions(workbenchId: string | null): Promise<AgentDefinitionRecord[]>;
  listPackageInstalls(workbenchId: string): Promise<PackageInstallRecord[]>;
  listPackageAgents(packageInstallId: string): Promise<AgentDefinitionRecord[]>;
  createAgentDefinition(input: Omit<AgentDefinitionRecord, "id">): Promise<AgentDefinitionRecord>;
  updateAgentDefinition(
    id: string,
    input: Pick<AgentDefinitionRecord, "body" | "meta" | "config" | "originalContentChecksum"> & {
      enabled?: boolean;
    },
  ): Promise<void>;
  deleteAgentDefinition(id: string): Promise<void>;

  findSkillBySlug(workbenchId: string | null, slug: string): Promise<SkillRecord | undefined>;
  findSkillDefinition(workbenchId: string | null, slug: string): Promise<SkillRecord | undefined>;
  /** Slug lookup including disabled/retired rows — install collision checks only. */
  findSkillDefinitionAnyState(
    workbenchId: string | null,
    slug: string,
  ): Promise<SkillRecord | undefined>;
  findSkillById(id: string): Promise<SkillRecord | undefined>;
  appendAgentDefinitionRevision(
    input: Omit<AgentDefinitionRevisionRecord, "id" | "createdAt">,
  ): Promise<AgentDefinitionRevisionRecord>;
  listAgentDefinitionRevisions(agentDefinitionId: string): Promise<AgentDefinitionRevisionRecord[]>;
  findAgentDefinitionRevision(id: string): Promise<AgentDefinitionRevisionRecord | undefined>;
  appendSkillDefinitionRevision(
    input: Omit<SkillDefinitionRevisionRecord, "id" | "createdAt">,
  ): Promise<SkillDefinitionRevisionRecord>;
  listSkillDefinitionRevisions(skillId: string): Promise<SkillDefinitionRevisionRecord[]>;
  findSkillDefinitionRevision(id: string): Promise<SkillDefinitionRevisionRecord | undefined>;
  listPackageSkills(packageInstallId: string): Promise<SkillRecord[]>;
  listWorkbenchSkills(workbenchId: string | null): Promise<SkillRecord[]>;
  /** Full skill inventory for a scope — includes disabled definitions. */
  listWorkbenchSkillDefinitions(workbenchId: string | null): Promise<SkillRecord[]>;
  listUserInstalledSkills(userId: string): Promise<UserInstalledSkillRecord[]>;
  createSkill(input: Omit<SkillRecord, "id">): Promise<SkillRecord>;
  updateSkill(
    id: string,
    input: Pick<SkillRecord, "body" | "meta" | "files" | "originalContentChecksum"> & {
      enabled?: boolean;
    },
  ): Promise<void>;
  deleteSkill(id: string): Promise<void>;

  linkAgentSkill(input: AgentSkillLinkRecord): Promise<void>;
  replaceAgentSkillLinks(agentDefinitionId: string, links: AgentSkillLinkRecord[]): Promise<void>;
  updateAgentSkillLinkModelInvocable(
    agentDefinitionId: string,
    skillId: string,
    modelInvocable: boolean,
  ): Promise<void>;
  listAgentSkillLinks(agentDefinitionId: string): Promise<AgentSkillLinkRecord[]>;
}

export interface PackageRepository {
  findPackageInstall(
    workbenchId: string,
    packageName: string,
  ): Promise<PackageInstallRecord | undefined>;
  transaction<T>(fn: (tx: PackageWriteTransaction) => Promise<T>): Promise<T>;

  /** Use-case-shaped read: resolve agent + merged skill set in one call. */
  getAgentWithLinkedSkills(
    workbenchId: string,
    userId: string,
    agentSlug: string,
  ): Promise<ResolvedPackageContext>;
}
