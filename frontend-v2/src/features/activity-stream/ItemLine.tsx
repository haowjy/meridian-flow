import type { ComponentType, ReactNode } from "react"

import { CaretDown, CaretRight } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ItemLineProps = {
  icon: ComponentType<{ className?: string }>
  label: string
  labelClassName?: string
  expanded: boolean
  onToggle: () => void
  children?: ReactNode
  className?: string
}

export function ItemLine({
  icon: Icon,
  label,
  labelClassName,
  expanded,
  onToggle,
  children,
  className,
}: ItemLineProps) {
  return (
    <div
      className={cn(
        "flex min-h-10 w-full items-center justify-between px-3 py-2",
        className
      )}
    >
      <Button
        variant="ghost"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-none px-0 py-0 text-sm font-normal hover:bg-transparent hover:opacity-70"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className={cn("truncate text-foreground", labelClassName)}>{label}</span>
      </Button>

      <span className="ml-2 flex shrink-0 items-center gap-2">
        {children}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-hidden="true"
          tabIndex={-1}
          className="size-5 rounded-none text-muted-foreground hover:text-foreground"
        >
          {expanded ? (
            <CaretDown className="size-3.5" />
          ) : (
            <CaretRight className="size-3.5" />
          )}
        </Button>
      </span>
    </div>
  )
}
