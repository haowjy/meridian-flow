// Package domain records: JSON-natural shapes shared by repository adapters and Mars sync.
import type { SkillFileEntry } from "./skill-files.js";

export type { SkillFileEntry, SkillFiles } from "./skill-files.js";

export type JsonObject = Record<string, unknown>;

export type PackageVisibility = "public" | "private";

export interface MarsPackageMetadata {
  name: string;
  version?: string;
  description?: string;
  visibility?: PackageVisibility;
}

export type AgentConfigOverlay = JsonObject;

export interface ParsedMarsToml {
  package: MarsPackageMetadata;
  agentOverlays: Record<string, AgentConfigOverlay>;
}

export interface ExportedMarsDirectory {
  files: Record<string, SkillFileEntry>;
}
