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

export interface AgentLevelFiles {
  read(input: { level: AgentsLevel; userId: string; projectId?: string }): Promise<LevelFiles>;
  /**
   * In each file's document, brings in the change from `base` to `target`, merged under the
   * document's own lock against what it holds then; where the writer changed the same text, their
   * text stays. Files are named level-relative; one whose document is gone is skipped, and none is
   * created or removed. Joins the caller's transaction. A user-level file resolves from the
   * account, so `projectId` is not needed there.
   */
  mergeFiles(input: {
    level: AgentsLevel;
    userId: string;
    projectId?: string;
    files: Record<string, { base: string; target: string }>;
  }): Promise<void>;
}

/** A host with no writer documents: only the built-in level exists. */
export const noLevelFiles: AgentLevelFiles = {
  read: async () => ({ files: {}, problems: {} }),
  mergeFiles: async () => {},
};
