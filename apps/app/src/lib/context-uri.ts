/**
 * context-uri — canonical frontend parsing, formatting, and route adaptation for context URIs.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

const URI_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/;
// A work/uploads URI carries a Work-id authority ONLY when its first segment is a
// real UUID (`work://<uuid>/path`). A bare `work://chapter.mdx` has no authority —
// the first segment is part of the path. Mirrors the canonical server parser
// (apps/server/.../context/context/uri.ts) so footer links resolve like the rest
// of the app. See issue: share one canonical URI parser across server + app.
const UUID_AUTHORITY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    const [firstSegment = "", ...pathParts] = remainder.split("/");
    if (UUID_AUTHORITY_PATTERN.test(firstSegment)) {
      return { scheme, authority: firstSegment, path: formatContextPath(pathParts.join("/")) };
    }
    // Bare work/uploads URI — no authority; the whole remainder is the path.
    return { scheme, authority: null, path: formatContextPath(remainder) };
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

  // Bare work URIs (no authority) resolve against the displayed work; an explicit
  // authority must match it.
  const workId = parsed.authority ?? activeWorkId;
  if (!workId || (parsed.authority && parsed.authority !== activeWorkId)) return null;
  return { scheme: parsed.scheme, path: parsed.path, workId };
}

function formatContextPath(value: string): string {
  return `/${value.replace(/^\/+/, "")}`;
}
