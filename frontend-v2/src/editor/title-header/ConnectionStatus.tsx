import { cn } from "@/lib/utils"

export type CollabConnectionState = "connected" | "reconnecting" | "disconnected"

interface ConnectionStatusProps {
  state: CollabConnectionState
  className?: string
}

const statusConfig: Record<
  CollabConnectionState,
  { dotClass: string; label: string }
> = {
  connected: {
    dotClass: "bg-success animate-pulse",
    label: "Connected",
  },
  reconnecting: {
    dotClass: "bg-warning animate-spin",
    label: "Reconnecting...",
  },
  disconnected: {
    dotClass: "bg-muted-foreground/50",
    label: "Offline",
  },
}

/**
 * Three-state connection status indicator.
 *
 * - **Connected**: green pulsing dot + "Connected"
 * - **Reconnecting**: amber spinning dot + "Reconnecting..."
 * - **Offline**: gray static dot + "Offline"
 */
export function ConnectionStatus({ state, className }: ConnectionStatusProps) {
  const config = statusConfig[state]

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <span
        className={cn("h-2 w-2 rounded-full", config.dotClass)}
        aria-hidden="true"
      />
      <span>{config.label}</span>
    </div>
  )
}
