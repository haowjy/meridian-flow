import type { ContextReadResponse } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getProjectDocumentRead } from "@/client/api/projects-api";

export type ContextReadStatus = {
  data: ContextReadResponse | null;
  status: "loading" | "ready" | "error";
  isError: boolean;
  isFetching: boolean;
  refetch: () => Promise<ContextReadResponse | null>;
};

export function useProjectContextRead(
  projectId: string,
  documentId: string | null,
): ContextReadStatus {
  const result = useQuery({
    queryKey: ["projects", projectId, "context", "read", documentId] as const,
    queryFn: () => getProjectDocumentRead(projectId, documentId ?? ""),
    enabled: documentId !== null,
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
