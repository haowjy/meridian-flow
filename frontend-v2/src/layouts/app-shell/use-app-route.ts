import * as React from "react"
import {
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router"

import { APP_MODE_LABELS, APP_MODES, type AppMode } from "@/components/ui/app-mode"

import {
  DEMO_DOCUMENT_PATH,
  DEMO_PROJECT_ID,
  DEMO_THREAD_ID,
} from "../shared/mock-data"
import {
  defaultRoute,
  routeForMode,
  type AppRoute,
} from "./route-paths"
import { agentsRoute, converseRoute, studioRoute } from "./routes"

function deriveAppRoute(
  params: Record<string, string | undefined>,
  matches: Array<{ routeId: string }>,
): AppRoute {
  const projectId = params.projectId ?? DEMO_PROJECT_ID

  if (matches.some((match) => match.routeId === agentsRoute.id)) {
    return { projectId, mode: "agents" }
  }

  if (matches.some((match) => match.routeId === converseRoute.id)) {
    return {
      projectId,
      mode: "converse",
      threadId: params.threadId ?? DEMO_THREAD_ID,
    }
  }

  if (matches.some((match) => match.routeId === studioRoute.id)) {
    return {
      projectId,
      mode: "studio",
      documentPath: params._splat ?? DEMO_DOCUMENT_PATH,
    }
  }

  return defaultRoute()
}

function isModKey(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey
}

function useModeKeyboardShortcuts(onModeChange: (mode: AppMode) => void) {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isModKey(event) || event.shiftKey || event.altKey) return

      const index = Number.parseInt(event.key, 10)
      if (index < 1 || index > 3) return

      const mode = APP_MODES[index - 1]
      if (!mode) return

      event.preventDefault()
      onModeChange(mode)
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onModeChange])
}

function useAppRoute(projectId?: string) {
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  const matches = useRouterState({ select: (state) => state.matches })

  const route = React.useMemo(
    () => deriveAppRoute(params, matches),
    [params, matches],
  )

  React.useEffect(() => {
    if (projectId && route.projectId !== projectId) {
      const next = routeForMode(
        { ...defaultRoute(), projectId },
        "converse",
      )
      navigate({
        to: converseRoute.to,
        params: {
          projectId: next.projectId,
          threadId: next.threadId ?? DEMO_THREAD_ID,
        },
        replace: true,
      })
    }
  }, [projectId, route.projectId, navigate])

  const [announcement, setAnnouncement] = React.useState("")

  const navigateToMode = React.useCallback(
    (
      mode: AppMode,
      overrides?: { threadId?: string; documentPath?: string },
    ) => {
      const next = routeForMode(route, mode, overrides)

      if (mode === "agents") {
        navigate({
          to: agentsRoute.to,
          params: { projectId: next.projectId },
        })
      } else if (mode === "converse") {
        navigate({
          to: converseRoute.to,
          params: {
            projectId: next.projectId,
            threadId: next.threadId ?? DEMO_THREAD_ID,
          },
        })
      } else {
        navigate({
          to: studioRoute.to,
          params: {
            projectId: next.projectId,
            _splat: next.documentPath ?? DEMO_DOCUMENT_PATH,
          },
        })
      }

      setAnnouncement(`${APP_MODE_LABELS[mode]} mode`)
    },
    [route, navigate],
  )

  useModeKeyboardShortcuts(navigateToMode)

  return {
    route,
    activeMode: route.mode,
    announcement,
    navigateToMode,
  }
}

export { useAppRoute }
export type { AppRoute } from "./route-paths"
