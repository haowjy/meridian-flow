import { cn } from "@/lib/utils"

export type EditorMode = "preview" | "source"

interface EditorModeTabsProps {
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
  className?: string
}

const modeLabels: Record<EditorMode, string> = {
  preview: "Live Preview",
  source: "Source",
}

export function EditorModeTabs({ mode, onModeChange, className }: EditorModeTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Editor mode"
      className={cn(
        "inline-flex h-8 items-center rounded-full border border-border/80 bg-muted/45 p-0.5",
        className
      )}
    >
      {(["preview", "source"] as const).map((nextMode) => {
        const active = mode === nextMode

        return (
          <button
            key={nextMode}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onModeChange(nextMode)}
            className={cn(
              "h-7 rounded-full px-3 text-xs font-medium tracking-[0.01em] transition",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              active
                ? "bg-card text-foreground shadow-elevation-subtle"
                : "bg-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {modeLabels[nextMode]}
          </button>
        )
      })}
    </div>
  )
}
