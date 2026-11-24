import type { AgentsLevel } from "@meridian/contracts/agents";
import type { SkillFiles } from "../domain/types.js";

export interface LevelFiles {
  files: SkillFiles;
  problems: Record<string, string>;
}

export interface ApplyFilesInput {
  level: AgentsLevel;
  userId: string;
  projectId?: string;
  files: Record<string, { base?: string; target?: string }>;
}

export interface FileChange {
  outcome: "merged" | "unchanged" | "skipped";
  clashes: number;
  documentId?: string;
  text?: string;
}

export type FileChanges = Record<string, FileChange>;

export interface AgentLevelFiles {
  read(input: { level: AgentsLevel; userId: string; projectId?: string }): Promise<LevelFiles>;
  prepareFiles(input: ApplyFilesInput): Promise<{ applyFiles(): Promise<FileChanges> }>;
}

export const noLevelFiles: AgentLevelFiles = {
  read: async () => ({ files: {}, problems: {} }),
  prepareFiles: async () => ({ applyFiles: async () => ({}) }),
};
