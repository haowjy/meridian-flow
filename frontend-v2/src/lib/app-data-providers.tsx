import type { ReactNode } from "react"

import { DocWsProvider } from "@/features/docs/DocWsProvider"
import { ThreadWsProvider } from "@/features/threads/streaming/ThreadWsProvider"
import { getAccessToken } from "@/lib/auth-token"

import { DEMO_PROJECT_ID } from "@/layouts/shared/mock-data"

interface AppDataProvidersProps {
  projectId?: string
  children: ReactNode
}

/**
 * REST query client + per-project WebSocket providers.
 * Skips WS mounts when projectId is absent or is the demo project
 * (stories/tests/demo mode without a real backend project).
 */
export function AppDataProviders({ projectId, children }: AppDataProvidersProps) {
  // Don't mount WS providers for missing or demo project IDs
  if (!projectId || projectId === DEMO_PROJECT_ID) {
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
