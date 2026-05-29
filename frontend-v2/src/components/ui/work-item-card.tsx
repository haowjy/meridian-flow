import * as React from "react"
import { ChatTeardrop } from "@phosphor-icons/react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

const workItemCardVariants = cva(
  "relative flex w-full cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-padding-relaxed text-left outline-none transition-colors hover:bg-muted/30 focus-visible:ring-focus-ring-width focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      selected: {
        true: "border-border",
        false: "",
      },
    },
    defaultVariants: {
      selected: false,
    },
  },
)

export type WorkItemStatus = "active" | "idle" | "completed" | "error"

const STATUS_BADGE_VARIANT: Record<
  WorkItemStatus,
  "default" | "secondary" | "destructive" | "outline" | "success" | "warning"
> = {
  active: "success",
  idle: "secondary",
  completed: "outline",
  error: "destructive",
}

const STATUS_LABELS: Record<WorkItemStatus, string> = {
  active: "Active",
  idle: "Idle",
  completed: "Completed",
  error: "Error",
}

type WorkItemCardProps = Omit<React.ComponentProps<"button">, "title"> &
  VariantProps<typeof workItemCardVariants> & {
    title: string
    status: WorkItemStatus
    threadCount: number
    lastActivity: string
    loading?: boolean
  }

function WorkItemCard({
  className,
  selected = false,
  title,
  status,
  threadCount,
  lastActivity,
  loading = false,
  disabled,
  ...props
}: WorkItemCardProps) {
  if (loading) {
    return (
      <div
        data-slot="work-item-card"
        data-loading
        className={cn(
          workItemCardVariants({ selected }),
          "pointer-events-none",
          className,
        )}
        aria-busy="true"
      >
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-3 w-24" />
      </div>
    )
  }

  return (
    <button
      type="button"
      data-slot="work-item-card"
      data-selected={selected || undefined}
      disabled={disabled}
      className={cn(workItemCardVariants({ selected }), className)}
      {...props}
    >
      {selected ? (
        <span
          data-slot="work-item-card-active-indicator"
          className="absolute top-3 bottom-3 left-0 w-0.5 rounded-full bg-accent-fill"
          aria-hidden
        />
      ) : null}
      <div className="flex items-start justify-between gap-2 pl-1">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <Badge variant={STATUS_BADGE_VARIANT[status]}>
          {STATUS_LABELS[status]}
        </Badge>
      </div>
      <p className="flex items-center gap-1.5 pl-1 text-sm text-muted-foreground">
        <ChatTeardrop size={16} aria-hidden />
        <span>
          {threadCount} {threadCount === 1 ? "thread" : "threads"}
        </span>
      </p>
      <p className="pl-1 text-xs text-muted-foreground">{lastActivity}</p>
    </button>
  )
}

export { WorkItemCard, workItemCardVariants, type WorkItemCardProps }
