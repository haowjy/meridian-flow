/** Where a level's Agent files live. The one place that spells those addresses. */

import type { ContextUriScheme, ProjectScopedContextUriScheme } from "../context-uri.js";
import { canonicalContextUri } from "../context-uri.js";

export type AgentsLevel = "user" | "project";

export interface AgentsLocation {
  level: AgentsLevel;
  /** Relative to the level's root: `agents/critic.md`, `packages/x/mars.toml`; empty for the root. */
  path: string;
}

/** The project level is its own source; the user level is a folder of the account's `user://`. */
const ROOTS = {
  user: { scheme: "user", path: ".agents" },
  project: { scheme: "agents", path: "" },
} as const satisfies Record<AgentsLevel, { scheme: ProjectScopedContextUriScheme; path: string }>;

/** Where a level's files live, for readers and provisioning. */
export function agentsRootOf(level: AgentsLevel): {
  scheme: ProjectScopedContextUriScheme;
  path: string;
} {
  return ROOTS[level];
}

/** Whether an address is in an Agents location, and at which level. */
export function agentsLocationOf(scheme: ContextUriScheme, path: string): AgentsLocation | null {
  for (const level of ["user", "project"] as const) {
    const root = ROOTS[level];
    if (scheme !== root.scheme) continue;
    if (root.path === "") return { level, path };
    if (path === root.path) return { level, path: "" };
    if (path.startsWith(`${root.path}/`)) return { level, path: path.slice(root.path.length + 1) };
  }
  return null;
}

/** The canonical address of a path in a level, for every place that prints one. */
export function agentsUriOf(level: AgentsLevel, path: string): string {
  const root = ROOTS[level];
  return canonicalContextUri(root.scheme, [root.path, path].filter(Boolean).join("/"));
}
