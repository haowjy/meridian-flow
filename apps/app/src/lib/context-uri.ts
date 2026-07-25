/**
 * context-uri — canonical frontend parsing, formatting, and route adaptation for context URIs.
 */
import {
  canonicalContextUri,
  type ParsedContextUri,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

export type ContextUri = Omit<ParsedContextUri, "path" | "canonical"> & {
  path: string;
};

export type ContextRouteTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
};

export function parseContextUri(uri: string): ContextUri | null {
  const parsed = parseUnifiedContextUri(uri);
  if (!parsed.ok) return null;
  return { ...parsed.value, path: formatContextPath(parsed.value.path) };
}

export function contextUriFromWritePath(path: string): string {
  const parsed = parseUnifiedContextUri(path);
  return parsed.ok
    ? parsed.value.canonical
    : canonicalContextUri("manuscript", path.replace(/^\/+/, ""));
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
