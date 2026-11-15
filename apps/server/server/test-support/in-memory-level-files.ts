/** Writer-owned Agent files for a test, by level: what the documents would hold. */
import type { AgentsLevel } from "@meridian/contracts/agents";
import { mergeCodeText } from "../domains/collab/domain/code-merge.js";
import type { AgentLevelFiles } from "../domains/packages/index.js";

export interface InMemoryLevelFiles extends AgentLevelFiles {
  write(level: AgentsLevel, path: string, text: string): void;
  remove(level: AgentsLevel, path: string): void;
}

export function createInMemoryLevelFiles(): InMemoryLevelFiles {
  const levels: Record<AgentsLevel, Record<string, string>> = { user: {}, project: {} };
  return {
    async read({ level }) {
      return { files: { ...levels[level] }, problems: {} };
    },
    async mergeFiles({ level, files }) {
      for (const [path, { base, target }] of Object.entries(files)) {
        // The real merge, and a file the writer deleted stays deleted.
        const live = levels[level][path];
        if (live !== undefined) levels[level][path] = mergeCodeText({ base, live, target });
      }
    },
    write(level, path, text) {
      levels[level][path] = text;
    },
    remove(level, path) {
      delete levels[level][path];
    },
  };
}
