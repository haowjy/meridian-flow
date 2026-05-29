import { WifiHigh, WifiSlash } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

type StatusBarProps = {
  connected: boolean
  /** Shown on the right when provided (e.g. credit balance). */
  creditBalance?: string
  className?: string
}

function StatusBar({ connected, creditBalance, className }: StatusBarProps) {
  return (
    <footer
      data-slot="status-bar"
      role="status"
      aria-live="polite"
      aria-label="Application status"
      className={cn(
        "flex h-6 w-full shrink-0 items-center border-t border-sidebar-border bg-sidebar px-padding-default text-xs text-muted-foreground",
        className,
      )}
    >
      <div
        data-slot="status-bar-connection"
        className="flex items-center gap-1.5"
      >
        {connected ? (
          <WifiHigh
            size={14}
            className="text-success"
            aria-hidden
          />
        ) : (
          <WifiSlash
            size={14}
            className="text-destructive"
            aria-hidden
          />
        )}
        <span>{connected ? "Connected" : "Disconnected"}</span>
      </div>

      <div className="flex-1" aria-hidden />

      {creditBalance ? (
        <span data-slot="status-bar-credits" className="tabular-nums">
          {creditBalance}
        </span>
      ) : null}
    </footer>
  )
}

export { StatusBar, type StatusBarProps }
