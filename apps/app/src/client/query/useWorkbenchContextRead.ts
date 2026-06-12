// @ts-nocheck
/**
 * useWorkbenchContextRead — read-route projection for non-tracked context files.
 *
 * Backed by `GET /api/workbenches/:workbenchId/context/:scheme/read?path=`, which
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

import type { ContextReadResponse, WorkbenchContextTreeScheme } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getWorkbenchContextRead } from "@/client/api/workbenches-api";

export type ContextReadStatus = {
  data: ContextReadResponse | null;
  status: "loading" | "ready" | "error" | "disabled";
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

export function contextReadQueryKey(
  workbenchId: string,
  scheme: WorkbenchContextTreeScheme,
  path: string,
) {
  return ["workbenches", workbenchId, "context", scheme, "read", path] as const;
}

export function useWorkbenchContextRead(
  workbenchId: string,
  scheme: WorkbenchContextTreeScheme | null,
  path: string | null,
  options?: { enabled?: boolean },
): ContextReadStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(scheme) && Boolean(path);
  const result = useQuery({
    queryKey: contextReadQueryKey(workbenchId, scheme ?? "kb", path ?? ""),
    queryFn: () =>
      getWorkbenchContextRead(workbenchId, scheme as WorkbenchContextTreeScheme, path as string),
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
