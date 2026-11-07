/**
 * useProjectContextRead — read-route projection for non-tracked context files.
 *
 * Backed by `GET /api/projects/:projectId/documents/:documentId/read`, which
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
 * The query is keyed and fetched by document identity: a rename or move is the
 * same file at a new path, so the bytes on screen stay and the read never asks
 * the server about a path.
 */

import type { ContextReadResponse } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getProjectDocumentRead } from "@/client/api/projects-api";

export type ContextReadStatus = {
  data: ContextReadResponse | null;
  status: "loading" | "ready" | "error";
  isError: boolean;
  isFetching: boolean;
  /** Re-reads, resolving to the fresh answer (null when failed). */
  refetch: () => Promise<ContextReadResponse | null>;
};

export function useProjectContextRead(projectId: string, documentId: string): ContextReadStatus {
  const result = useQuery({
    queryKey: ["projects", projectId, "context", "read", documentId] as const,
    queryFn: () => getProjectDocumentRead(projectId, documentId),
    // Signed URLs are short-lived. Re-fetch on focus / remount, never cache hot.
    staleTime: 0,
    gcTime: 60_000,
    retry: 0,
  });

  return {
    data: result.data ?? null,
    status: result.isError ? "error" : result.data ? "ready" : "loading",
    isError: result.isError,
    isFetching: result.isFetching,
    refetch: async () => (await result.refetch()).data ?? null,
  };
}
