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
  /** Level-relative paths. No base means empty text; no target requests deletion. */
  files: Record<string, { base?: string; target?: string }>;
  create: boolean;
  delete: boolean;
}

export type FileChange =
  | {
      outcome: "created" | "merged" | "deleted" | "unchanged" | "skipped";
      clashes: number;
      documentId?: string;
      text?: string;
    }
  | {
      outcome: "landed-elsewhere";
      path: string;
      actualPath: string;
      clashes: number;
      documentId?: string;
      text?: string;
    };

export type FileChanges = Record<string, FileChange>;

export interface AgentLevelFiles {
  read(input: { level: AgentsLevel; userId: string; projectId?: string }): Promise<LevelFiles>;
  /**
   * Plan and bind before the caller opens its transaction. With creation off no binding is
   * needed, so Undo may prepare inside its transaction. Call the returned applyFiles inside
   * that transaction after the package's Save locks; it takes the list before document locks.
   * An obstructed path (folder, blocked ancestor, prose or binary) keeps its occupant.
   * With creation enabled, a target lands at a settled name and reports landed-elsewhere
   * with requested path and actualPath; deletion is skipped. Calls retain no path history:
   * import and update callers must record actualPath and pass it on their next call.
   * A deletion keeps a file whose text differs from its base and reports one clash.
   */
  prepareFiles(input: ApplyFilesInput): Promise<{ applyFiles(): Promise<FileChanges> }>;
}

/** A host with no writer documents: only the built-in level exists. */
export const noLevelFiles: AgentLevelFiles = {
  read: async () => ({ files: {}, problems: {} }),
  prepareFiles: async () => ({ applyFiles: async () => ({}) }),
};
