import { CaretDown } from "@phosphor-icons/react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Button } from "@/components/ui/button"
import { ScrollBar } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

const BOTTOM_THRESHOLD_PX = 20
const MASK_FADE_PX = 28
const SLOT_GUTTER_PX = 12

type FloatingScrollLayoutProps = {
  topSlot?: ReactNode
  bottomSlot?: ReactNode
  children: ReactNode
  className?: string
  autoScrollToBottom?: boolean
  showScrollToBottom?: boolean
  isStreaming?: boolean
  resetKey?: string
}

function isAtBottom(element: HTMLElement) {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_THRESHOLD_PX
}

export function FloatingScrollLayout({
  topSlot,
  bottomSlot,
  children,
  className,
  autoScrollToBottom = true,
  showScrollToBottom = true,
  isStreaming = false,
  resetKey,
}: FloatingScrollLayoutProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const topSlotRef = useRef<HTMLDivElement | null>(null)
  const bottomSlotRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(autoScrollToBottom)
  const previousResetKeyRef = useRef(resetKey)
  const resetCycleRef = useRef(0)
  const autoScrollToBottomRef = useRef(autoScrollToBottom)
  useEffect(() => {
    autoScrollToBottomRef.current = autoScrollToBottom
  }, [autoScrollToBottom])

  const [topSlotHeight, setTopSlotHeight] = useState(0)
  const [bottomSlotHeight, setBottomSlotHeight] = useState(0)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)
  const [isContentReady, setIsContentReady] = useState(true)

  const refreshScrollState = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const maxScrollTop = Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
    const nextCanScrollUp = viewport.scrollTop > 1
    const nextCanScrollDown = viewport.scrollTop < maxScrollTop - 1

    setCanScrollUp(nextCanScrollUp)
    setCanScrollDown(nextCanScrollDown)

    if (autoScrollToBottom) {
      shouldStickToBottomRef.current = isAtBottom(viewport)
    }
  }, [autoScrollToBottom])

  const refreshScrollStateRef = useRef(refreshScrollState)
  useEffect(() => {
    refreshScrollStateRef.current = refreshScrollState
  }, [refreshScrollState])

  const scrollToBottom = useCallback(
    (behavior?: ScrollBehavior) => {
      const viewport = viewportRef.current
      if (!viewport) {
        return
      }

      shouldStickToBottomRef.current = true
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: behavior ?? (isStreaming ? "auto" : "smooth"),
      })
    },
    [isStreaming]
  )

  const refreshSlotHeights = useCallback(() => {
    setTopSlotHeight(topSlotRef.current?.offsetHeight ?? 0)
    setBottomSlotHeight(bottomSlotRef.current?.offsetHeight ?? 0)
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    shouldStickToBottomRef.current =
      autoScrollToBottom && (viewport ? isAtBottom(viewport) : true)
  }, [autoScrollToBottom])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const onScroll = () => {
      refreshScrollState()
    }

    viewport.addEventListener("scroll", onScroll, { passive: true })
    refreshScrollState()

    return () => {
      viewport.removeEventListener("scroll", onScroll)
    }
  }, [refreshScrollState])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      refreshSlotHeights()
    })

    if (typeof ResizeObserver === "undefined") {
      return () => {
        cancelAnimationFrame(frame)
      }
    }

    const observer = new ResizeObserver(() => {
      refreshSlotHeights()
    })

    const topSlotElement = topSlotRef.current
    const bottomSlotElement = bottomSlotRef.current

    if (topSlotElement) {
      observer.observe(topSlotElement)
    }

    if (bottomSlotElement) {
      observer.observe(bottomSlotElement)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [topSlot, bottomSlot, refreshSlotHeights])

  useLayoutEffect(() => {
    if (resetKey === undefined) {
      previousResetKeyRef.current = resetKey
      // Intentional synchronous restore: a prior reset cycle may have hidden content.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsContentReady(true)
      return
    }

    if (previousResetKeyRef.current === resetKey) {
      return
    }

    previousResetKeyRef.current = resetKey

    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    let frameCount = 0
    let stableFrameCount = 0
    let previousScrollHeight = -1
    let frame = 0
    const cycleId = resetCycleRef.current + 1
    resetCycleRef.current = cycleId
    // Intentional synchronous hide: prevents showing new-thread content at stale scroll position.
    setIsContentReady(false)

    const revealContent = () => {
      if (resetCycleRef.current !== cycleId) {
        return
      }

      if (autoScrollToBottomRef.current) {
        shouldStickToBottomRef.current = true
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" })
      }

      refreshScrollStateRef.current()
      setIsContentReady(true)
    }

    const waitForStableLayout = () => {
      if (resetCycleRef.current !== cycleId) {
        return
      }

      const nextScrollHeight = viewport.scrollHeight
      stableFrameCount = nextScrollHeight === previousScrollHeight ? stableFrameCount + 1 : 0
      previousScrollHeight = nextScrollHeight
      frameCount += 1

      if (stableFrameCount >= 2 || frameCount >= 60) {
        revealContent()
        return
      }

      frame = requestAnimationFrame(waitForStableLayout)
    }

    frame = requestAnimationFrame(waitForStableLayout)

    return () => {
      cancelAnimationFrame(frame)
    }
    // Only re-run when resetKey changes — autoScrollToBottom and refreshScrollState
    // are read from refs to avoid cancelling in-flight gating cycles.
  }, [resetKey])

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return
    }

    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const observer = new ResizeObserver(() => {
      if (autoScrollToBottom && shouldStickToBottomRef.current) {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: isStreaming ? "auto" : "smooth",
        })
      }

      refreshScrollState()
    })

    observer.observe(viewport)

    if (contentRef.current) {
      observer.observe(contentRef.current)
    }

    return () => {
      observer.disconnect()
    }
  }, [autoScrollToBottom, isStreaming, refreshScrollState])

  const topContentPadding = topSlotHeight + SLOT_GUTTER_PX
  const bottomContentPadding = bottomSlotHeight + SLOT_GUTTER_PX

  const shouldShowScrollToBottomButton = showScrollToBottom && canScrollDown
  const scrollBehavior: ScrollBehavior = isStreaming ? "auto" : "smooth"

  const maskImage = useMemo(() => {
    if (!canScrollUp && !canScrollDown) {
      return "none"
    }

    const topFade = canScrollUp ? MASK_FADE_PX : 0
    const bottomFade = canScrollDown ? MASK_FADE_PX : 0

    return `linear-gradient(to bottom, transparent 0px, black ${topFade}px, black calc(100% - ${bottomFade}px), transparent 100%)`
  }, [canScrollUp, canScrollDown])

  const viewportStyle: CSSProperties = {
    maskImage,
    WebkitMaskImage: maskImage,
  }

  return (
    <div className={cn("relative flex h-full min-h-0 w-full overflow-hidden", className)}>
      <ScrollAreaPrimitive.Root className="relative min-h-0 flex-1 overflow-hidden">
        <ScrollAreaPrimitive.Viewport ref={viewportRef} className="h-full w-full" style={viewportStyle}>
          <div
            ref={contentRef}
            className={cn(
              "mx-auto flex w-full max-w-4xl flex-col gap-4 px-4",
              !isContentReady && "pointer-events-none opacity-0"
            )}
            style={{
              paddingTop: topContentPadding,
              paddingBottom: bottomContentPadding,
            }}
          >
            {children}
          </div>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar />
      </ScrollAreaPrimitive.Root>

      {topSlot ? (
        <div ref={topSlotRef} className="pointer-events-none absolute inset-x-0 top-0 z-20">
          <div className="pointer-events-auto">{topSlot}</div>
        </div>
      ) : null}

      {showScrollToBottom ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 z-30 flex justify-center px-4 transition-opacity duration-200",
            shouldShowScrollToBottomButton ? "opacity-100" : "opacity-0"
          )}
          style={{ bottom: bottomSlotHeight + SLOT_GUTTER_PX }}
        >
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className={cn(
              "pointer-events-auto size-10 rounded-full border border-border/80 bg-background/95 shadow-md backdrop-blur",
              !shouldShowScrollToBottomButton && "pointer-events-none"
            )}
            aria-label="Scroll to bottom"
            onClick={() => {
              scrollToBottom(scrollBehavior)
            }}
          >
            <CaretDown className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      {bottomSlot ? (
        <div ref={bottomSlotRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
          <div className="pointer-events-auto">{bottomSlot}</div>
        </div>
      ) : null}
    </div>
  )
}
