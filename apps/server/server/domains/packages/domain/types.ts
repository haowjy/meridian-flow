// Package domain records: JSON-natural shapes shared by repository adapters and Mars sync.
import type { SkillFileEntry, SkillFiles } from "./skill-files.js";

export type { SkillFileEntry, SkillFiles } from "./skill-files.js";

export type JsonObject = Record<string, unknown>;

export type PackageVisibility = "public" | "private";

export interface MarsPackageMetadata {
  name: string;
  version?: string;
  description?: string;
  visibility?: PackageVisibility;
}

export interface MarsDependency {
  name: string;
  path?: string;
  url?: string;
  version?: string;
  local: boolean;
}

export type AgentConfigOverlay = JsonObject;

export interface ParsedMarsToml {
  package: MarsPackageMetadata;
  dependencies: MarsDependency[];
  agentOverlays: Record<string, AgentConfigOverlay>;
}

export interface ParsedAgentDefinition {
  slug: string;
  body: string;
  meta: JsonObject;
}

export interface ParsedSkillDefinition {
  slug: string;
  body: string;
  meta: JsonObject;
  files: SkillFiles;
}

export interface ParsedMarsPackageSource {
  sourceDir: string;
  manifest: ParsedMarsToml;
  agents: ParsedAgentDefinition[];
  skills: ParsedSkillDefinition[];
}

export interface PackageInstallRecord {
  id: string;
  projectId: string;
  sourcePath?: string;
  /** Git ref persisted for GitHub installs — reused on update fetch. */
  sourceRef?: string | null;
  sourceCommitSha?: string | null;
  packageName: string;
  version?: string;
  description?: string;
  visibility: PackageVisibility;
}

export interface AgentDefinitionRecord {
  id: string;
  projectId: string | null;
  slug: string;
  body: string;
  meta: JsonObject;
  config: JsonObject;
  packageInstallId: string | null;
  originalContentChecksum: string | null;
  sourceType: "builtin" | "package" | "user";
  enabled: boolean;
}

export interface SkillRecord {
  id: string;
  projectId: string | null;
  slug: string;
  body: string;
  meta: JsonObject;
  files: SkillFiles;
  packageInstallId: string | null;
  originalContentChecksum: string | null;
  sourceType: "builtin" | "package" | "user";
  enabled: boolean;
}

export interface UserInstalledSkillRecord {
  id: string;
  userId: string;
  slug: string;
  body: string;
  meta: JsonObject;
  files: SkillFiles;
  sourceChecksum: string | null;
  originalContentChecksum: string | null;
  enabled: boolean;
}

export interface AgentSkillLinkRecord {
  agentDefinitionId: string;
  skillId: string;
  ordinal?: number;
  modelInvocable?: boolean;
  userInvocable?: boolean;
}

export interface AgentDefinitionRevisionRecord {
  id: string;
  agentDefinitionId: string;
  contentChecksum: string;
  body: string;
  meta: JsonObject;
  config: JsonObject;
  createdAt: string;
}

export interface SkillDefinitionRevisionRecord {
  id: string;
  skillId: string;
  contentChecksum: string;
  body: string;
  meta: JsonObject;
  files: SkillFiles;
  createdAt: string;
}

export interface PackageImportResult {
  installedPackages: PackageInstallRecord[];
  skippedPackages: string[];
  insertedAgents: AgentDefinitionRecord[];
  insertedSkills: SkillRecord[];
  skippedAgents: string[];
  skippedSkills: string[];
}

export interface PackageUpdateResult {
  packageInstall?: PackageInstallRecord;
  updatedAgents: string[];
  updatedSkills: string[];
  removedAgents: string[];
  removedSkills: string[];
  /** Soft-retired on upstream prune — disabled with `meta.removedFromSource`, history kept. */
  retiredAgents: string[];
  retiredSkills: string[];
  skippedAgents: string[];
  skippedSkills: string[];
}

export interface ExportedMarsDirectory {
  files: Record<string, SkillFileEntry>;
}

export interface ResolvedPackageContext {
  agent?: AgentDefinitionRecord;
  skills: ResolvedSkill[];
}

export interface ResolvedSkill {
  skill: SkillRecord | UserInstalledSkillRecord;
  layer: "builtin" | "user" | "project";
  modelInvocable: boolean;
  userInvocable: boolean;
}
