import * as React from "react"

import type { AppMode } from "@/components/ui/app-mode"

const focusMemory = new Map<AppMode, HTMLElement>()

function useFocusRestore(mode: AppMode, isActive: boolean) {
  const containerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!isActive) return

    const remembered = focusMemory.get(mode)
    if (remembered?.isConnected) {
      remembered.focus({ preventScroll: true })
      return
    }

    const fallback = containerRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, textarea, [tabindex]:not([tabindex="-1"])',
    )
    fallback?.focus({ preventScroll: true })
  }, [isActive, mode])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container || !isActive) return

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && container.contains(target)) {
        focusMemory.set(mode, target)
      }
    }

    container.addEventListener("focusin", handleFocusIn)
    return () => container.removeEventListener("focusin", handleFocusIn)
  }, [isActive, mode])

  return containerRef
}

export { useFocusRestore }
