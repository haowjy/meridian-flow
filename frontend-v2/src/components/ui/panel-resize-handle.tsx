import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const panelResizeHandleVariants = cva(
  "group/handle relative z-10 shrink-0 outline-none focus-visible:ring-focus-ring-width focus-visible:ring-ring/50",
  {
    variants: {
      orientation: {
        vertical:
          "w-1 cursor-col-resize before:absolute before:-inset-x-1 before:inset-y-0 before:content-['']",
        horizontal:
          "h-1 cursor-row-resize before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']",
      },
    },
    defaultVariants: {
      orientation: "vertical",
    },
  },
)

const KEYBOARD_STEP_PX = 20
const KEYBOARD_SHIFT_STEP_PX = 100

type PanelResizeHandleProps = Omit<
  React.ComponentProps<"div">,
  "onResize"
> &
  VariantProps<typeof panelResizeHandleVariants> & {
    /** Current pane size in pixels (for aria-valuenow). */
    value: number
    min: number
    max: number
    defaultValue: number
    onResize?: (value: number) => void
    onResizeCommit?: (value: number) => void
    onReset?: () => void
  }

function PanelResizeHandle({
  className,
  orientation = "vertical",
  value,
  min,
  max,
  defaultValue,
  onResize,
  onResizeCommit,
  onReset,
  ...props
}: PanelResizeHandleProps) {
  const [isDragging, setIsDragging] = React.useState(false)
  const [isHovered, setIsHovered] = React.useState(false)
  const cancelValueRef = React.useRef(value)
  const dragValueRef = React.useRef(value)

  React.useEffect(() => {
    dragValueRef.current = value
  }, [value])

  const clamp = React.useCallback(
    (next: number) => Math.min(max, Math.max(min, next)),
    [min, max],
  )

  const applyResize = React.useCallback(
    (next: number) => {
      onResize?.(clamp(next))
    },
    [clamp, onResize],
  )

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      cancelValueRef.current = dragValueRef.current
      dragValueRef.current = value
      setIsDragging(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [value],
  )

  const handlePointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return
      const delta =
        orientation === "vertical" ? e.movementX : e.movementY
      const next = clamp(dragValueRef.current + delta)
      dragValueRef.current = next
      applyResize(next)
    },
    [applyResize, clamp, isDragging, orientation],
  )

  const handlePointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return
      setIsDragging(false)
      e.currentTarget.releasePointerCapture(e.pointerId)
      onResizeCommit?.(dragValueRef.current)
    },
    [isDragging, onResizeCommit],
  )

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? KEYBOARD_SHIFT_STEP_PX : KEYBOARD_STEP_PX
      const delta =
        orientation === "vertical"
          ? e.key === "ArrowLeft"
            ? -step
            : e.key === "ArrowRight"
              ? step
              : 0
          : e.key === "ArrowUp"
            ? -step
            : e.key === "ArrowDown"
              ? step
              : 0

      if (delta !== 0) {
        e.preventDefault()
        applyResize(value + delta)
        return
      }

      if (e.key === "Enter") {
        e.preventDefault()
        dragValueRef.current = defaultValue
        onReset?.()
        applyResize(defaultValue)
        onResizeCommit?.(defaultValue)
        return
      }

      if (e.key === "Escape") {
        e.preventDefault()
        applyResize(cancelValueRef.current)
        onResizeCommit?.(cancelValueRef.current)
      }
    },
    [
      applyResize,
      defaultValue,
      onReset,
      onResizeCommit,
      orientation,
      value,
    ],
  )

  const handleDoubleClick = React.useCallback(() => {
    onReset?.()
    applyResize(defaultValue)
    onResizeCommit?.(defaultValue)
  }, [applyResize, defaultValue, onReset, onResizeCommit])

  const lineActive = isDragging || isHovered

  return (
    <div
      data-slot="panel-resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation={orientation ?? "vertical"}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label="Resize panel"
      className={cn(panelResizeHandleVariants({ orientation }), className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
      data-dragging={isDragging || undefined}
      {...props}
    >
      <span
        data-slot="panel-resize-handle-line"
        aria-hidden
        className={cn(
          "pointer-events-none absolute bg-border transition-colors",
          orientation === "vertical"
            ? "top-0 bottom-0 left-1/2 -translate-x-1/2"
            : "top-1/2 right-0 left-0 -translate-y-1/2",
          lineActive
            ? "bg-accent-fill"
            : undefined,
          orientation === "vertical"
            ? lineActive
              ? "w-0.5"
              : "w-px"
            : lineActive
              ? "h-0.5"
              : "h-px",
        )}
      />
    </div>
  )
}

export {
  PanelResizeHandle,
  panelResizeHandleVariants,
  KEYBOARD_SHIFT_STEP_PX,
  KEYBOARD_STEP_PX,
  type PanelResizeHandleProps,
}
