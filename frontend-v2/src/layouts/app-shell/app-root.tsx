import { Outlet, useParams } from "@tanstack/react-router"

import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { AppDataProviders } from "@/lib/app-data-providers"
import { AppQueryClientProvider } from "@/lib/query-client"

import { AppShell } from "./AppShell"

/**
 * Root route layout — providers + always-mounted AppShell.
 *
 * projectId is derived from the URL, not hardcoded. When the URL has no
 * projectId (e.g. "/" or catch-all), routes.ts redirects before this
 * renders with an undefined projectId.
 */
function AppRoot() {
  const params = useParams({ strict: false })
  const projectId = params.projectId as string | undefined

  return (
    <ThemeProvider defaultTheme="system">
      <AppQueryClientProvider>
        <AppDataProviders projectId={projectId}>
          <AppShell projectId={projectId} />
          {/* Mode routes are URL markers only; shells stay mounted in AppShell. */}
          <Outlet />
        </AppDataProviders>
        <Toaster />
      </AppQueryClientProvider>
    </ThemeProvider>
  )
}

export { AppRoot }
