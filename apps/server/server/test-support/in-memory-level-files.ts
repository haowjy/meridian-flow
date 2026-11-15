/** Writer-owned Agent files for a test, by level: what the documents would hold. */
import type { AgentsLevel } from "@meridian/contracts/agents";
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
    async writeFiles({ level, files }) {
      for (const [path, text] of Object.entries(files)) {
        if (text === null) delete levels[level][path];
        else levels[level][path] = text;
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
