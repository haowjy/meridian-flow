import * as React from "react"

import type { AppMode } from "@/components/ui/app-mode"

type ShellVisibilityContextValue = {
  activeMode: AppMode
}

const ShellVisibilityContext =
  React.createContext<ShellVisibilityContextValue | null>(null)

/** Set by ModeShellContainer — lets descendants pause work without knowing their mode. */
const ModeShellActiveContext = React.createContext<boolean | null>(null)

function ShellVisibilityProvider({
  activeMode,
  children,
}: {
  activeMode: AppMode
  children: React.ReactNode
}) {
  const value = React.useMemo(() => ({ activeMode }), [activeMode])
  return (
    <ShellVisibilityContext.Provider value={value}>
      {children}
    </ShellVisibilityContext.Provider>
  )
}

function ModeShellActiveProvider({
  active,
  children,
}: {
  active: boolean
  children: React.ReactNode
}) {
  return (
    <ModeShellActiveContext.Provider value={active}>
      {children}
    </ModeShellActiveContext.Provider>
  )
}

function useShellVisibility(): ShellVisibilityContextValue {
  const ctx = React.useContext(ShellVisibilityContext)
  if (!ctx) {
    throw new Error("useShellVisibility must be used within ShellVisibilityProvider")
  }
  return ctx
}

/** Defaults to active when used outside app/mode shell providers (stories, tests). */
function useIsShellActive(mode?: AppMode): boolean {
  const visibility = React.useContext(ShellVisibilityContext)
  const localActive = React.useContext(ModeShellActiveContext)

  if (mode !== undefined) {
    return visibility ? visibility.activeMode === mode : true
  }

  return localActive ?? true
}

function useShellActive(mode: AppMode): boolean {
  return useIsShellActive(mode)
}

export {
  ModeShellActiveContext,
  ModeShellActiveProvider,
  ShellVisibilityContext,
  ShellVisibilityProvider,
  useIsShellActive,
  useShellActive,
  useShellVisibility,
  type ShellVisibilityContextValue,
}
