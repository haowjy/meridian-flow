import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Project } from '../types/project'
import { ProjectCardFeatured } from './ProjectCardFeatured'

const CARD_WIDTH_CLASS = 'w-[clamp(10.5rem,28vw,20rem)]'

interface ProjectFeaturedCardListProps {
  projects: Project[]
  onFavoriteToggle?: (id: string) => void
  scrollable?: boolean // false = bounded (only renders what fits), true = scrollable (renders all with scroll buttons)
  ariaLabel: string
}

const CARD_GAP_PX = 16 // gap-4

// ─────────────────────────────────────────────────────────────────────────────
// Bounded mode helpers (when scrollable=false)
// ─────────────────────────────────────────────────────────────────────────────

function getRootFontSizePx(): number {
  const px = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 16
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function getFeaturedCardWidthPx(viewportWidthPx: number): number {
  // Must match `CARD_WIDTH_CLASS` (clamp(10.5rem, 28vw, 20rem)).
  // We compute it in JS so we can render ONLY the number of full cards that fit
  // in a single row, without horizontal scrolling.
  const rootFontPx = getRootFontSizePx()
  const minPx = 10.5 * rootFontPx
  const preferredPx = 0.28 * viewportWidthPx
  const maxPx = 20 * rootFontPx
  return clamp(preferredPx, minPx, maxPx)
}

function computeMaxVisibleCards(containerWidthPx: number, cardWidthPx: number): number {
  if (containerWidthPx <= 0 || cardWidthPx <= 0) return 1
  // Total width for N cards: N*card + (N-1)*gap <= container
  // Solve for N: N <= (container + gap) / (card + gap)
  const n = Math.floor((containerWidthPx + CARD_GAP_PX) / (cardWidthPx + CARD_GAP_PX))
  return Math.max(1, n)
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ProjectFeaturedCardList({
  projects,
  onFavoriteToggle,
  scrollable = false,
  ariaLabel,
}: ProjectFeaturedCardListProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Bounded mode state
  const [maxVisible, setMaxVisible] = useState(1)

  // Scrollable mode state
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  // ─────────────────────────────────────────────────────────────────────────────
  // Bounded mode: calculate how many cards fit
  // ─────────────────────────────────────────────────────────────────────────────

  const updateMaxVisible = useMemo(() => {
    return () => {
      if (scrollable) return
      const el = containerRef.current
      if (!el) return
      const containerWidthPx = el.clientWidth
      const cardWidthPx = getFeaturedCardWidthPx(window.innerWidth)
      setMaxVisible(computeMaxVisibleCards(containerWidthPx, cardWidthPx))
    }
  }, [scrollable])

  useEffect(() => {
    if (scrollable) return

    updateMaxVisible()

    const el = containerRef.current
    if (!el) return

    const ro = new ResizeObserver(() => updateMaxVisible())
    ro.observe(el)

    window.addEventListener('resize', updateMaxVisible)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updateMaxVisible)
    }
  }, [scrollable, updateMaxVisible])

  // ─────────────────────────────────────────────────────────────────────────────
  // Scrollable mode: track scroll position for chevron buttons
  // ─────────────────────────────────────────────────────────────────────────────

  const updateScrollState = useCallback(() => {
    if (!scrollable) return
    const el = containerRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }, [scrollable])

  useEffect(() => {
    if (!scrollable) return

    updateScrollState()
    window.addEventListener('resize', updateScrollState)
    return () => window.removeEventListener('resize', updateScrollState)
  }, [scrollable, updateScrollState, projects.length])

  const getScrollStep = useCallback(() => {
    const el = containerRef.current
    if (!el) return 0

    const firstCard = el.querySelector<HTMLElement>('[data-card]')
    if (firstCard) {
      return firstCard.offsetWidth + CARD_GAP_PX
    }

    return Math.round(el.clientWidth * 0.9)
  }, [])

  const scroll = useCallback((direction: 'left' | 'right') => {
    const el = containerRef.current
    if (!el) return

    const step = getScrollStep()
    el.scrollTo({
      left: el.scrollLeft + (direction === 'left' ? -step : step),
      behavior: 'smooth',
    })
  }, [getScrollStep])

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  if (projects.length === 0) return null

  const visibleProjects = scrollable ? projects : projects.slice(0, maxVisible)

  if (scrollable) {
    return (
      <div className="relative">
        <div
          ref={containerRef}
          onScroll={updateScrollState}
          aria-label={ariaLabel}
          className="flex min-w-0 gap-4 overflow-x-auto py-2 scrollbar-hide"
          style={{ scrollSnapType: 'x mandatory' }}
        >
          {visibleProjects.map((project) => (
            <div
              key={project.id}
              data-card
              className="flex-shrink-0 snap-start"
            >
              <ProjectCardFeatured
                project={project}
                onFavoriteToggle={onFavoriteToggle}
                className={CARD_WIDTH_CLASS}
              />
            </div>
          ))}
        </div>

        {canScrollLeft && (
          <div className="pointer-events-none absolute inset-y-0 -left-3 flex items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              className="pointer-events-auto bg-background/70 backdrop-blur-sm border border-border"
              onClick={() => scroll('left')}
              aria-label={`Scroll ${ariaLabel} left`}
            >
              <ChevronLeft className="size-4" />
            </Button>
          </div>
        )}

        {canScrollRight && (
          <div className="pointer-events-none absolute inset-y-0 -right-3 flex items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              className="pointer-events-auto bg-background/70 backdrop-blur-sm border border-border"
              onClick={() => scroll('right')}
              aria-label={`Scroll ${ariaLabel} right`}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
      </div>
    )
  }

  // Bounded mode (default)
  return (
    <div
      ref={containerRef}
      aria-label={ariaLabel}
      className="flex flex-nowrap gap-4 overflow-hidden"
    >
      {visibleProjects.map((project) => (
        <ProjectCardFeatured
          key={project.id}
          project={project}
          onFavoriteToggle={onFavoriteToggle}
          className={`${CARD_WIDTH_CLASS} flex-none`}
        />
      ))}
    </div>
  )
}
