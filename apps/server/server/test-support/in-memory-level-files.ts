/** Writer-owned Agent files for a test, by level: what the documents would hold. */
import type { AgentsLevel } from "@meridian/contracts/agents";
import { mergeCodeText } from "../domains/collab/domain/code-merge.js";
import type { AgentLevelFiles } from "../domains/packages/index.js";
import type { FileChanges } from "../domains/packages/ports/agent-level-files.js";

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
    async prepareFiles({ level, files, create, delete: remove }) {
      return {
        async applyFiles() {
          const results: FileChanges = {};
          for (const [path, { base, target }] of Object.entries(files)) {
            const live = levels[level][path];
            if (base === undefined && target === undefined) {
              results[path] = { outcome: "skipped", clashes: 0 };
            } else if (live === undefined && target !== undefined && create) {
              levels[level][path] = target;
              results[path] = { outcome: "created", text: target, clashes: 0 };
            } else if (live !== undefined && target === undefined && remove && live === base) {
              delete levels[level][path];
              results[path] = { outcome: "deleted", clashes: 0 };
            } else if (live !== undefined && target !== undefined) {
              const merged = mergeCodeText({ base: base ?? "", live, target });
              levels[level][path] = merged.text;
              results[path] = { ...merged, outcome: merged.text === live ? "unchanged" : "merged" };
            } else if (live !== undefined && target === undefined && remove) {
              results[path] = { outcome: "unchanged", text: live, clashes: 1 };
            } else
              results[path] = {
                outcome: "skipped",
                clashes: 0,
              };
          }
          return results;
        },
      };
    },
    write(level, path, text) {
      levels[level][path] = text;
    },
    remove(level, path) {
      delete levels[level][path];
    },
  };
}
