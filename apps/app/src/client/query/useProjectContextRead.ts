// @ts-nocheck
/**
 * useProjectContextRead — read-route projection for non-tracked context files.
 *
 * Backed by `GET /api/projects/:projectId/context/:scheme/read?path=`, which
 * returns either:
 *   - `{ kind: "tracked", ... }` — markdown projection (not used by the
 *     collaborative editor surface; that still binds the Yjs WS), or
 *   - `{ kind: "binary", url, mimeType }` — a short-lived signed URL the
 *     viewer renders directly.
 *
 * The signed URL has a TTL; we treat the response as stale-fast (`staleTime:
 * 0`) and keep it in cache only briefly. UI state is honest via
 * `ContextReadStatus` instead of `array.length`.
 */

import type { ContextReadResponse, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getProjectContextRead } from "@/client/api/projects-api";

export type ContextReadStatus = {
  data: ContextReadResponse | null;
  status: "loading" | "ready" | "error" | "disabled";
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

export function contextReadQueryKey(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  path: string,
) {
  return ["projects", projectId, "context", scheme, "read", path] as const;
}

export function useProjectContextRead(
  projectId: string,
  scheme: ProjectContextTreeScheme | null,
  path: string | null,
  options?: { enabled?: boolean },
): ContextReadStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(scheme) && Boolean(path);
  const result = useQuery({
    queryKey: contextReadQueryKey(projectId, scheme ?? "kb", path ?? ""),
    queryFn: () =>
      getProjectContextRead(projectId, scheme as ProjectContextTreeScheme, path as string),
    enabled,
    // Signed URLs are short-lived. Re-fetch on focus / remount, never cache hot.
    staleTime: 0,
    gcTime: 60_000,
    retry: 0,
  });

  if (!enabled) {
    return {
      data: null,
      status: "disabled",
      isError: false,
      isFetching: false,
      refetch: () => {},
    };
  }

  return {
    data: result.data ?? null,
    status: result.isError ? "error" : result.data ? "ready" : "loading",
    isError: result.isError,
    isFetching: result.isFetching,
    refetch: () => {
      void result.refetch();
    },
  };
}
