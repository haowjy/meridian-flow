/**
 * context-uri — canonical frontend parsing, formatting, and route adaptation for context URIs.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

const URI_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/;
const ROUTABLE_CONTEXT_SCHEMES = new Set<ProjectContextTreeScheme>([
  "manuscript",
  "kb",
  "user",
  "work",
  "uploads",
]);

export type ContextUri = {
  scheme: ProjectContextTreeScheme;
  authority: string | null;
  path: string;
};

export type ContextRouteTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
};

export function parseContextUri(uri: string): ContextUri | null {
  const match = URI_PATTERN.exec(uri);
  if (!match) return null;
  const scheme = match[1] as ProjectContextTreeScheme;
  if (!ROUTABLE_CONTEXT_SCHEMES.has(scheme)) return null;

  const remainder = match[2] ?? "";
  if (isWorkScopedProjectContextScheme(scheme)) {
    const [authority = "", ...pathParts] = remainder.split("/");
    if (!authority) return null;
    return { scheme, authority, path: formatContextPath(pathParts.join("/")) };
  }

  return { scheme, authority: null, path: formatContextPath(remainder) };
}

export function contextUriFromWritePath(path: string): string {
  if (URI_PATTERN.test(path)) return path;
  return `manuscript://${path.replace(/^\/+/, "")}`;
}

export function displayContextPath(uri: string, fallback: string): string {
  return parseContextUri(uri)?.path ?? fallback;
}

export function contextRouteTargetFromUri(
  uri: string,
  activeWorkId: string | null,
): ContextRouteTarget | null {
  const parsed = parseContextUri(uri);
  if (!parsed) return null;

  if (!isWorkScopedProjectContextScheme(parsed.scheme)) {
    return { scheme: parsed.scheme, path: parsed.path, workId: null };
  }

  if (!parsed.authority || parsed.authority !== activeWorkId) return null;
  return { scheme: parsed.scheme, path: parsed.path, workId: parsed.authority };
}

function formatContextPath(value: string): string {
  return `/${value.replace(/^\/+/, "")}`;
}
