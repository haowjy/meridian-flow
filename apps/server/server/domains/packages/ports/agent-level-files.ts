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
}

/** A host with no writer documents: only the built-in level exists. */
export const noLevelFiles: AgentLevelFiles = {
  read: async () => ({ files: {}, problems: {} }),
};
