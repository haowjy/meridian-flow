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
 *
 * The query is keyed by document identity: a rename or move is the same file at
 * a new path, and the bytes already on screen stay. The route is still addressed
 * by path, so while the writer's own move is unconfirmed (`settling`) nothing is
 * read: the server doesn't know the new path yet. The read follows when it lands.
 */

import type { ContextReadResponse, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getProjectContextRead } from "@/client/api/projects-api";

import { type ContextOwner, contextRequestOptionsForScheme } from "./context-request-options";

export type ContextReadStatus = {
  data: ContextReadResponse | null;
  status: "loading" | "ready" | "error" | "disabled";
  isError: boolean;
  isFetching: boolean;
  /** Re-reads, resolving to the fresh answer (null when disabled or failed). */
  refetch: () => Promise<ContextReadResponse | null>;
};

function contextReadQueryKey(projectId: string, documentId: string, owner: ContextOwner) {
  const ownerId = owner.chatThreadId ?? owner.rootThreadId ?? owner.workId ?? null;
  return ["projects", projectId, "context", "read", documentId, ownerId] as const;
}

export function useProjectContextRead(
  projectId: string,
  scheme: ProjectContextTreeScheme | null,
  path: string | null,
  options: { enabled?: boolean; documentId: string; settling?: boolean } & ContextOwner,
): ContextReadStatus {
  const callerEnabled = options.enabled ?? true;
  const enabled = callerEnabled && Boolean(scheme) && Boolean(path);
  const contextOpts = scheme ? contextRequestOptionsForScheme(scheme, options) : undefined;
  const settling = options.settling === true;
  const result = useQuery({
    queryKey: contextReadQueryKey(projectId, options.documentId, options),
    queryFn: () =>
      getProjectContextRead(
        projectId,
        scheme as ProjectContextTreeScheme,
        path as string,
        contextOpts,
      ),
    enabled: enabled && !settling,
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
      refetch: async () => null,
    };
  }

  return {
    data: result.data ?? null,
    status: result.isError ? "error" : result.data ? "ready" : "loading",
    isError: result.isError,
    isFetching: result.isFetching,
    refetch: async () => (settling ? result.data : (await result.refetch()).data) ?? null,
  };
}
