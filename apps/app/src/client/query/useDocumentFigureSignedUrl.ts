/**
 * useDocumentFigureSignedUrl — mints a short-lived signed read URL for a
 * project document via the figure-asset endpoint, used by the rail upload
 * viewer (and any future read-only inline document preview by id).
 */
import type { GetFigureSignedUrlResponse } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getFigureSignedUrl } from "@/client/api/figures-api";

export type DocumentFigureSignedUrlStatus =
  | { status: "loading"; data: null; isError: false }
  | { status: "ready"; data: GetFigureSignedUrlResponse; isError: false }
  | { status: "error"; data: null; isError: true; refetch: () => void }
  | { status: "disabled"; data: null; isError: false };

export function useDocumentFigureSignedUrl(
  projectId: string | null,
  documentId: string | null,
): DocumentFigureSignedUrlStatus {
  const enabled = Boolean(projectId) && Boolean(documentId);
  const query = useQuery({
    queryKey: ["document-figure-signed-url", projectId, documentId] as const,
    queryFn: () =>
      getFigureSignedUrl({
        projectId: projectId as string,
        documentId: documentId as string,
      }),
    enabled,
    // Signed URLs are short-lived; allow re-mint within the same viewer
    // session if the user dismisses + reopens.
    staleTime: 60_000,
  });

  if (!enabled) return { status: "disabled", data: null, isError: false };
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
  if (query.data) return { status: "ready", data: query.data, isError: false };
  return { status: "loading", data: null, isError: false };
}
