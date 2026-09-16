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

export interface ExportedMarsDirectory {
  files: Record<string, SkillFileEntry>;
}
