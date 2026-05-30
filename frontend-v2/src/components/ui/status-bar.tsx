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
        "flex h-5 w-full shrink-0 items-center bg-sidebar px-padding-default text-xs text-muted-foreground/60",
        className,
      )}
    >
      <div
        data-slot="status-bar-connection"
        className="flex items-center gap-1.5"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            connected ? "bg-success" : "bg-muted-foreground/40",
          )}
          aria-hidden
        />
        <span>{connected ? "Connected" : "Offline"}</span>
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
