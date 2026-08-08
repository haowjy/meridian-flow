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
import { parseRequestId } from "@meridian/contracts/request-id";

export type ContextUri = Omit<ParsedContextUri, "path" | "canonical"> & {
  path: string;
};

export type ContextRouteTarget = {
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

export function contextUriFromWritePath(path: string): string {
  const parsed = parseUnifiedContextUri(path);
  return parsed.ok
    ? parsed.value.canonical
    : canonicalContextUri("manuscript", path.replace(/^\/+/, ""));
}

export function contextRouteTargetFromUri(
  uri: string,
  activeWork: ActiveWorkHandle | null,
): ContextRouteTarget | null {
  const persisted = persistedWorkRouteTarget(uri, activeWork);
  if (persisted !== undefined) return persisted;

  const parsed = parseContextUri(uri);
  if (!parsed) return null;

  if (!isWorkScopedProjectContextScheme(parsed.scheme)) {
    return { scheme: parsed.scheme, path: parsed.path, workId: null };
  }

  // URI navigation never changes the displayed Work. A qualifier is routable
  // here only when it names that already-active Work.
  if (!activeWork || (parsed.authority && parsed.authority !== activeWork.slug)) return null;
  return { scheme: parsed.scheme, path: parsed.path, workId: activeWork.id };
}

/** Stable persisted context locations use Work IDs, not the LLM-facing `@slug` grammar. */
function persistedWorkRouteTarget(
  uri: string,
  activeWork: ActiveWorkHandle | null,
): ContextRouteTarget | null | undefined {
  const match = uri.trim().match(/^(scratch|uploads):\/\/([^/]+)(?:\/(.*))?$/);
  if (!match) return undefined;
  const workId = parseRequestId(match[2]);
  if (!workId) return undefined;
  if (!activeWork || workId !== activeWork.id) return null;
  return {
    scheme: match[1] as ProjectContextTreeScheme,
    path: formatContextPath(match[3] ?? ""),
    workId,
  };
}

export function canOpenContextUri(uri: string, activeWork: ActiveWorkHandle | null): boolean {
  return contextRouteTargetFromUri(uri, activeWork) !== null;
}

function formatContextPath(value: string): string {
  return `/${value.replace(/^\/+/, "")}`;
}
