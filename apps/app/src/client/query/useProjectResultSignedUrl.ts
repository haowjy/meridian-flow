// @ts-nocheck
/**
 * useProjectResultSignedUrl — mints a short-lived read URL for a Results
 * row, used by the rail's viewer overlay.
 *
 * Each call to this hook re-requests a signed URL on mount (per result),
 * so the URL is always fresh enough for the duration of a viewer session.
 * No retry on auth failures — the route returns 404 for both unknown
 * results and access denials and the rail surfaces the same "couldn't
 * load" state.
 */
import { useQuery } from "@tanstack/react-query";

import {
  getProjectResultSignedUrl,
  type ProjectResultSignedUrlResponse,
} from "@/client/api/project-results-api";

import { projectQueryKeys } from "./project-query-keys";

export type ProjectResultSignedUrlStatus =
  | { status: "loading"; data: null; isError: false }
  | { status: "ready"; data: ProjectResultSignedUrlResponse; isError: false }
  | { status: "error"; data: null; isError: true; refetch: () => void }
  | { status: "disabled"; data: null; isError: false };

export function useProjectResultSignedUrl(
  projectId: string | null,
  resultId: string | null,
): ProjectResultSignedUrlStatus {
  const enabled = Boolean(projectId) && Boolean(resultId);
  const query = useQuery({
    queryKey: projectQueryKeys.resultSignedUrl(projectId ?? "", resultId ?? ""),
    queryFn: () => getProjectResultSignedUrl(projectId as string, resultId as string),
    enabled,
    // Signed URLs are short-lived; allow the viewer to re-mint within the
    // same session if the user reopens the artifact.
    staleTime: 60_000,
  });

  if (!enabled) {
    return { status: "disabled", data: null, isError: false };
  }
  if (query.isError) {
    return {
      status: "error",
      data: null,
      isError: true,
      refetch: () => {
        void query.refetch();
      },
    };
  }
  if (query.data) {
    return { status: "ready", data: query.data, isError: false };
  }
  return { status: "loading", data: null, isError: false };
}
