/** A level's package files as the writer's documents hold them now. */
import type { AgentsLevel } from "@meridian/contracts/agents";
import type { SkillFiles } from "../domain/types.js";

export interface LevelFiles {
  /** Plain text of each document, keyed by level-root-relative path (`agents/critic.md`). */
  files: SkillFiles;
  /**
   * Paths whose documents cannot be read as a package file: what is stored there is not plain
   * text, or two documents answer to one path. The level still owns the path.
   */
  problems: Record<string, string>;
}

export interface ApplyFilesInput {
  level: AgentsLevel;
  userId: string;
  projectId?: string;
  /** Level-relative paths. No base means empty text; a path with no target is skipped. */
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
  /**
   * Merge each file's target into the document that holds it, through the documents' own write
   * path. Call the returned applyFiles inside the caller's transaction after the package's Save
   * locks; it takes the list before document locks. A file with no document, or whose path is
   * obstructed (folder, blocked ancestor, prose or binary), is skipped and keeps its occupant;
   * Undo never creates or deletes a file.
   */
  prepareFiles(input: ApplyFilesInput): Promise<{ applyFiles(): Promise<FileChanges> }>;
}

/** A host with no writer documents: only the built-in level exists. */
export const noLevelFiles: AgentLevelFiles = {
  read: async () => ({ files: {}, problems: {} }),
  prepareFiles: async () => ({ applyFiles: async () => ({}) }),
};
