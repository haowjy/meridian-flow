import * as React from "react"
import { X } from "@phosphor-icons/react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const DEFAULT_DETENTS = [0.5, 0.9] as const

type BottomSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  detents?: readonly number[]
  /** Detent height as a fraction of viewport (0–1). Defaults to first detent. */
  activeDetent?: number
  onDetentChange?: (detent: number) => void
  title?: string
  subtitle?: string
  showCloseButton?: boolean
  children: React.ReactNode
  actionBar?: React.ReactNode
  className?: string
}

function BottomSheet({
  open,
  onOpenChange,
  detents = DEFAULT_DETENTS,
  activeDetent,
  onDetentChange,
  title,
  subtitle,
  showCloseButton = true,
  children,
  actionBar,
  className,
}: BottomSheetProps) {
  const [internalDetent, setInternalDetent] = React.useState(detents[0])
  const dragStartY = React.useRef(0)
  const [dragOffset, setDragOffset] = React.useState(0)
  const [isDragging, setIsDragging] = React.useState(false)

  const currentDetent = activeDetent ?? internalDetent

  const setDetent = React.useCallback(
    (detent: number) => {
      if (activeDetent === undefined) {
        setInternalDetent(detent)
      }
      onDetentChange?.(detent)
    },
    [activeDetent, onDetentChange],
  )

  React.useEffect(() => {
    if (!open) {
      setDragOffset(0)
      setIsDragging(false)
    }
  }, [open])

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    setIsDragging(true)
    dragStartY.current = e.clientY
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return
    const delta = Math.max(0, e.clientY - dragStartY.current)
    setDragOffset(delta)
  }

  const handlePointerUp = () => {
    if (!isDragging) return
    setIsDragging(false)
    const dismissThreshold =
      typeof window !== "undefined"
        ? window.innerHeight * currentDetent * 0.4
        : 160
    if (dragOffset > dismissThreshold) {
      onOpenChange(false)
    }
    setDragOffset(0)
  }

  const heightPercent = Math.round(currentDetent * 100)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="bottom-sheet-overlay"
          className="fixed inset-0 z-50 bg-foreground/10 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          data-slot="bottom-sheet"
          role="dialog"
          aria-label={title ?? "Bottom sheet"}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-xl border-t border-border bg-card shadow-elevation-overlay outline-none",
            "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom",
            "pb-[env(safe-area-inset-bottom)]",
            className,
          )}
          style={{
            height: `${heightPercent}dvh`,
            transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div
            data-slot="bottom-sheet-grabber"
            className="flex cursor-grab touch-none justify-center py-3 active:cursor-grabbing"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <span
              className="h-1 w-10 rounded-full bg-muted"
              aria-hidden
            />
          </div>

          {(title || subtitle || showCloseButton) && (
            <header
              data-slot="bottom-sheet-header"
              className="flex items-start gap-3 px-padding-default pb-2"
            >
              <div className="min-w-0 flex-1">
                {title ? (
                  <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                    {title}
                  </DialogPrimitive.Title>
                ) : null}
                {subtitle ? (
                  <DialogPrimitive.Description className="mt-0.5 text-sm text-muted-foreground">
                    {subtitle}
                  </DialogPrimitive.Description>
                ) : null}
              </div>
              {showCloseButton ? (
                <DialogPrimitive.Close asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="min-h-touch-target min-w-touch-target shrink-0"
                    aria-label="Close"
                  >
                    <X className="size-4" />
                  </Button>
                </DialogPrimitive.Close>
              ) : null}
            </header>
          )}

          {detents.length > 1 ? (
            <div
              data-slot="bottom-sheet-detent-controls"
              className="flex gap-2 px-padding-default pb-2"
              role="group"
              aria-label="Sheet height"
            >
              {detents.map((detent) => (
                <Button
                  key={detent}
                  type="button"
                  size="sm"
                  variant={detent === currentDetent ? "secondary" : "ghost"}
                  onClick={() => setDetent(detent)}
                >
                  {Math.round(detent * 100)}%
                </Button>
              ))}
            </div>
          ) : null}

          <div
            data-slot="bottom-sheet-content"
            className="min-h-0 flex-1 overflow-y-auto px-padding-default"
          >
            {children}
          </div>

          {actionBar ? (
            <footer
              data-slot="bottom-sheet-action-bar"
              className="shrink-0 border-t border-border px-padding-default py-padding-default"
            >
              {actionBar}
            </footer>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export { BottomSheet, DEFAULT_DETENTS, type BottomSheetProps }
