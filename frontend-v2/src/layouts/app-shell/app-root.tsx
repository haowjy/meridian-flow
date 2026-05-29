import { Outlet } from "@tanstack/react-router"

import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { AppDataProviders } from "@/lib/app-data-providers"
import { AppQueryClientProvider } from "@/lib/query-client"

import { DEMO_PROJECT_ID } from "../shared/mock-data"
import { AppShell } from "./AppShell"

/** Root route layout — providers + always-mounted AppShell. */
function AppRoot() {
  return (
    <ThemeProvider defaultTheme="system">
      <AppQueryClientProvider>
        <AppDataProviders projectId={DEMO_PROJECT_ID}>
          <AppShell projectId={DEMO_PROJECT_ID} />
          {/* Mode routes are URL markers only; shells stay mounted in AppShell. */}
          <Outlet />
        </AppDataProviders>
        <Toaster />
      </AppQueryClientProvider>
    </ThemeProvider>
  )
}

export { AppRoot }
