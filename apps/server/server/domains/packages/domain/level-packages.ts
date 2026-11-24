import type { AgentsLevel } from "@meridian/contracts/agents";
import type { LevelFiles } from "../ports/agent-level-files.js";
import { type AgentSourceSnapshot, isPackagePath } from "./compile-package.js";
import { MANIFEST_PATH } from "./mars.js";
import type { SkillFiles } from "./types.js";

export const PACKAGES_DIR = "packages/";

export const defaultManifest = (level: AgentsLevel): string =>
  `[package]\nname = "${level}"\nversion = "0.0.0"\nschema = 1\n`;

export interface LevelPackages {
  root: AgentSourceSnapshot | null;
  imports: Array<{ name: string; source: AgentSourceSnapshot }>;
}

export function splitLevel(level: AgentsLevel, read: LevelFiles): LevelPackages {
  const rootFiles: SkillFiles = {};
  const rootProblems: Record<string, string> = {};
  const imports = new Map<string, { files: SkillFiles; problems: Record<string, string> }>();
  const place = (
    path: string,
    put: (files: SkillFiles, problems: Record<string, string>, rest: string) => void,
  ) => {
    if (!path.startsWith(PACKAGES_DIR)) return put(rootFiles, rootProblems, path);
    const inside = path.slice(PACKAGES_DIR.length);
    const slash = inside.indexOf("/");
    if (slash <= 0) return;
    const name = inside.slice(0, slash);
    const entry = imports.get(name) ?? { files: {}, problems: {} };
    imports.set(name, entry);
    put(entry.files, entry.problems, inside.slice(slash + 1));
  };
  for (const [path, text] of Object.entries(read.files)) {
    place(path, (files, _problems, rest) => {
      if (isPackagePath(rest)) files[rest] = text;
    });
  }
  for (const [path, message] of Object.entries(read.problems)) {
    place(path, (_files, problems, rest) => {
      if (isPackagePath(rest)) problems[rest] = message;
    });
  }
  const rootPresent = Object.keys(rootFiles).length > 0 || Object.keys(rootProblems).length > 0;
  if (!Object.hasOwn(rootFiles, MANIFEST_PATH) && !Object.hasOwn(rootProblems, MANIFEST_PATH)) {
    rootFiles[MANIFEST_PATH] = defaultManifest(level);
  }
  return {
    root: rootPresent ? { coordinate: level, files: rootFiles, problems: rootProblems } : null,
    imports: [...imports]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, { files, problems }]) => ({
        name,
        source: { coordinate: `${level}/${PACKAGES_DIR}${name}`, files, problems },
      })),
  };
}
