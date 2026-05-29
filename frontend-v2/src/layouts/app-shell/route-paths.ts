import type { AppMode } from "@/components/ui/app-mode"

export type AppRoute = {
  projectId: string
  mode: AppMode
  threadId?: string
  documentPath?: string
}

export type NavigateOptions = {
  replace?: boolean
  threadId?: string
  documentPath?: string
}

export function routeForMode(
  current: AppRoute,
  mode: AppMode,
  overrides?: Pick<NavigateOptions, "threadId" | "documentPath">,
): AppRoute {
  return {
    projectId: current.projectId,
    mode,
    threadId:
      mode === "converse"
        ? (overrides?.threadId ?? current.threadId)
        : current.threadId,
    documentPath:
      mode === "studio"
        ? (overrides?.documentPath ?? current.documentPath)
        : current.documentPath,
  }
}
