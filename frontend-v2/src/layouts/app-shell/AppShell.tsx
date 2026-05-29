import * as React from "react"

import { BottomNav, type BottomNavTab } from "@/components/ui/bottom-nav"
import { Rail } from "@/components/ui/rail"
import { StatusBar } from "@/components/ui/status-bar"
import { BottomSheet } from "@/components/ui/bottom-sheet"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import type { AppMode } from "@/components/ui/app-mode"
import { cn } from "@/lib/utils"

import { AgentsShell } from "../agents/AgentsShell"
import { ConverseShell } from "../converse/ConverseShell"
import { StudioShell } from "../studio/StudioShell"
import { ModeShellContainer } from "../shared/mode-shell-container"
import { useConnectionStatus } from "./use-connection-status"
import { ShellVisibilityProvider } from "./shell-visibility-context"
import { useAppRoute } from "./use-app-route"

type AppShellProps = {
  projectId?: string
  className?: string
}

function AppShell({ projectId, className }: AppShellProps) {
  const { route, activeMode, announcement, navigateToMode } =
    useAppRoute()
  const { connected } = useConnectionStatus()
  const [bottomTab, setBottomTab] = React.useState<BottomNavTab>(activeMode)
  const [moreOpen, setMoreOpen] = React.useState(false)

  React.useEffect(() => {
    setBottomTab(activeMode)
  }, [activeMode])

  const handleModeChange = React.useCallback(
    (mode: AppMode) => {
      navigateToMode(mode)
    },
    [navigateToMode],
  )

  const handleBottomNavChange = React.useCallback((tab: BottomNavTab) => {
    if (tab === "more") {
      setMoreOpen(true)
      setBottomTab("more")
      return
    }
    setBottomTab(tab)
    handleModeChange(tab)
  }, [handleModeChange])

  const handleOpenInConverse = React.useCallback(
    (threadId: string) => {
      navigateToMode("converse", { threadId })
    },
    [navigateToMode],
  )

  return (
    <ShellVisibilityProvider activeMode={activeMode}>
      <div
        data-slot="app-shell"
        className={cn(
          "grid h-dvh w-screen overflow-hidden bg-background",
          "grid-cols-1 grid-rows-[1fr_auto]",
          "nav-rail:grid-cols-[3rem_1fr] nav-rail:grid-rows-[1fr_auto]",
          "desktop:grid-rows-[1fr_1.5rem]",
          className,
        )}
      >
        <Rail
          activeMode={activeMode}
          onModeChange={handleModeChange}
          onOpenSettings={() => setMoreOpen(true)}
          className="col-start-1 row-start-1 hidden nav-rail:flex"
        />

        <main
          className={cn(
            "relative col-start-1 row-start-1 min-h-0 min-w-0 overflow-hidden",
            "nav-rail:col-start-2",
            "pb-bottom-nav-height nav-rail:pb-0",
          )}
        >
          <ModeShellContainer mode="agents">
            <AgentsShell
              projectId={projectId}
              onOpenInConverse={handleOpenInConverse}
            />
          </ModeShellContainer>
          <ModeShellContainer mode="converse">
            <ConverseShell
              projectId={projectId}
              threadId={route.threadId}
              threadTitle="Chapter 19 pacing revision"
            />
          </ModeShellContainer>
          <ModeShellContainer mode="studio">
            <StudioShell
              projectId={projectId}
              activeDocumentPath={route.documentPath}
            />
          </ModeShellContainer>
        </main>

        <StatusBar
          connected={connected}
          creditBalance="42 credits"
          className={cn(
            "col-span-1 row-start-2 hidden border-t border-sidebar-border",
            "desktop:col-span-2 desktop:flex",
          )}
        />

        <BottomNav
          activeTab={bottomTab}
          onTabChange={handleBottomNavChange}
          showMoreAlert={!connected}
          className="col-start-1 row-start-2 nav-rail:hidden static inset-auto z-30"
        />

        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>

        <BottomSheet
          open={moreOpen}
          onOpenChange={setMoreOpen}
          title="More"
          subtitle="Settings and status"
        >
          <div className="flex flex-col gap-4 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Theme</span>
              <ThemeToggle />
            </div>
            <p className="text-xs text-muted-foreground">
              Connected · 42 credits (mock shell)
            </p>
          </div>
        </BottomSheet>
      </div>
    </ShellVisibilityProvider>
  )
}

export { AppShell, type AppShellProps }
