import type { ReactNode } from "react"

import { DocWsProvider } from "@/features/docs/DocWsProvider"
import { ThreadWsProvider } from "@/features/threads/streaming/ThreadWsProvider"
import { getAccessToken } from "@/lib/auth-token"

interface AppDataProvidersProps {
  projectId?: string
  children: ReactNode
}

/**
 * REST query client + per-project WebSocket providers.
 * Skips WS mounts when projectId is absent (stories/tests without a project).
 */
export function AppDataProviders({ projectId, children }: AppDataProvidersProps) {
  if (!projectId) {
    return children
  }

  return (
    <ThreadWsProvider projectId={projectId} getToken={getAccessToken}>
      <DocWsProvider projectId={projectId} getToken={getAccessToken}>
        {children}
      </DocWsProvider>
    </ThreadWsProvider>
  )
}
