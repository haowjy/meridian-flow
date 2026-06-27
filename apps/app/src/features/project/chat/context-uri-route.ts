/**
 * context-uri-route — project-boundary mapping from canonical context URIs to
 * the route's scheme/path selection tuple.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

const ROUTABLE_CONTEXT_SCHEMES = new Set<ProjectContextTreeScheme>([
  "manuscript",
  "kb",
  "user",
  "work",
  "uploads",
]);

export type ContextRouteTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
};

export function contextRouteTargetFromUri(
  uri: string,
  activeWorkId: string | null,
): ContextRouteTarget | null {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(uri);
  if (!match) return null;
  const scheme = match[1] as ProjectContextTreeScheme;
  if (!ROUTABLE_CONTEXT_SCHEMES.has(scheme)) return null;

  const remainder = match[2] ?? "";
  if (!isWorkScopedProjectContextScheme(scheme)) {
    return { scheme, path: pathFromSegments(remainder), workId: null };
  }

  const [workId, ...pathParts] = remainder.split("/");
  if (!workId || workId !== activeWorkId) return null;
  return { scheme, path: pathFromSegments(pathParts.join("/")), workId };
}

function pathFromSegments(value: string): string {
  return `/${value.replace(/^\/+/, "")}`;
}
