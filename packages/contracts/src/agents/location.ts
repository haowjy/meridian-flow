import type { ContextUriScheme, ProjectScopedContextUriScheme } from "../context-uri.js";
import { readSegment } from "../protocol/entry-segment.js";

export type AgentsLevel = "user" | "project";

export interface AgentsLocation {
  level: AgentsLevel;
  path: string;
}

const ROOTS = {
  user: { scheme: "user", path: ".agents" },
  project: { scheme: "agents", path: "" },
} as const satisfies Record<AgentsLevel, { scheme: ProjectScopedContextUriScheme; path: string }>;

export function agentsRootOf(level: AgentsLevel): {
  scheme: ProjectScopedContextUriScheme;
  path: string;
} {
  return ROOTS[level];
}

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

const AGENT_FILE = /^(?:packages\/[^/]+\/)?agents\/([^/]+)\.md$/;
const SKILL_FILE = /^(?:packages\/[^/]+\/)?skills\/([^/]+)\/SKILL\.md$/;

export function agentsFileOf(path: string): { kind: "agent" | "skill"; slug: string } | null {
  if (path.split("/").some((segment) => readSegment(segment).suffix !== undefined)) return null;
  const agent = AGENT_FILE.exec(path)?.[1];
  if (agent) return { kind: "agent", slug: agent };
  const skill = SKILL_FILE.exec(path)?.[1];
  return skill ? { kind: "skill", slug: skill } : null;
}
