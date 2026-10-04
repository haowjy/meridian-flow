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

export type ContextUri = Omit<ParsedContextUri, "path"> & {
  path: string;
};

/** Parsed URI destination before the route owner supplies command ownership. */
export type ParsedContextUriTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
};

export type ActiveWorkHandle = { id: string; slug: string };

export function parseContextUri(uri: string): ContextUri | null {
  const parsed = parseUnifiedContextUri(uri);
  if (!parsed.ok) return null;
  return { ...parsed.value, path: formatContextPath(parsed.value.path) };
}

/**
 * The context URI a tool path names: bare paths are manuscript paths. `null`
 * for a path under a scheme that addresses no writer document (`skills://`),
 * which must never be filed under the manuscript.
 */
export function contextUriFromWritePath(path: string): string | null {
  const parsed = parseUnifiedContextUri(path);
  if (parsed.ok) return parsed.value.normalized;
  if (parsed.error.unknownScheme !== undefined) return null;
  return canonicalContextUri("manuscript", path.replace(/^\/+/, ""));
}

export function contextRouteTargetFromUri(
  uri: string,
  activeWork: ActiveWorkHandle | null,
  availableWorks: readonly ActiveWorkHandle[] = activeWork ? [activeWork] : [],
): ParsedContextUriTarget | null {
  const parsed = parseContextUri(uri);
  if (!parsed) return null;

  if (!isWorkScopedProjectContextScheme(parsed.scheme)) {
    return { scheme: parsed.scheme, path: parsed.path, workId: null };
  }

  if (parsed.authority.kind === "none") {
    return { scheme: parsed.scheme, path: parsed.path, workId: null };
  }
  if (parsed.authority.kind === "contextual") {
    return { scheme: parsed.scheme, path: parsed.path, workId: activeWork?.id ?? null };
  }
  const requestedSlug = parsed.authority.workSlug;
  const qualified = availableWorks.find(({ slug }) => slug === requestedSlug);
  return qualified ? { scheme: parsed.scheme, path: parsed.path, workId: qualified.id } : null;
}

export function canOpenContextUri(
  uri: string,
  activeWork: ActiveWorkHandle | null,
  availableWorks?: readonly ActiveWorkHandle[],
): boolean {
  return contextRouteTargetFromUri(uri, activeWork, availableWorks) !== null;
}

function formatContextPath(value: string): string {
  return `/${value.replace(/^\/+/, "")}`;
}
