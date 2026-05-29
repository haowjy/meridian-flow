import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

import { queryKeys } from "./keys"

export function useProjects(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: ({ signal }) => api.projects.list({ signal }),
    enabled: options?.enabled ?? true,
  })
}

export function useProject(
  projectId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: projectId
      ? queryKeys.projects.detail(projectId)
      : ["projects", "__none__"],
    queryFn: ({ signal }) => {
      if (!projectId) throw new Error("projectId is required")
      return api.projects.get(projectId, { signal })
    },
    enabled: (options?.enabled ?? true) && !!projectId,
  })
}
