import type { AppMode } from "@/components/ui/app-mode"

import {
  DEMO_DOCUMENT_PATH,
  DEMO_PROJECT_ID,
  DEMO_THREAD_ID,
} from "../shared/mock-data"

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

export function defaultRoute(): AppRoute {
  return {
    projectId: DEMO_PROJECT_ID,
    mode: "converse",
    threadId: DEMO_THREAD_ID,
  }
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
        ? (overrides?.threadId ?? current.threadId ?? DEMO_THREAD_ID)
        : current.threadId,
    documentPath:
      mode === "studio"
        ? (overrides?.documentPath ??
          current.documentPath ??
          DEMO_DOCUMENT_PATH)
        : current.documentPath,
  }
}
