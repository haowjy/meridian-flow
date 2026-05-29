import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

import { queryKeys } from "./keys"

export function useDocumentTree(
  projectId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: projectId
      ? queryKeys.projects.documentTree(projectId)
      : ["projects", "__none__", "tree"],
    queryFn: ({ signal }) => {
      if (!projectId) throw new Error("projectId is required")
      return api.documents.getTree(projectId, { signal })
    },
    enabled: (options?.enabled ?? true) && !!projectId,
  })
}
