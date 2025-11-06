"use client"

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SegmentedIconToggleProps {
  value: 0 | 1
  onChange: (value: 0 | 1) => void
  leftIcon: React.ReactNode
  rightIcon: React.ReactNode
  className?: string
  leftTitle?: string
  rightTitle?: string
  /** Optional inset (px) for the highlight around the active button */
  thumbInset?: number
  /** Optional CSS border-radius for the highlight; defaults to active button's border-radius */
  thumbRadius?: string
  /** Layout behavior: 'fill' gives equal segments; 'content' sizes to icon content. */
  variant?: 'fill' | 'content'
}

export function SegmentedIconToggle({
  value,
  onChange,
  leftIcon,
  rightIcon,
  className,
  leftTitle,
  rightTitle,
  thumbInset,
  thumbRadius,
  variant = 'fill',
}: SegmentedIconToggleProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const leftRef = React.useRef<HTMLButtonElement | null>(null)
  const rightRef = React.useRef<HTMLButtonElement | null>(null)
  const leftIconRef = React.useRef<HTMLSpanElement | null>(null)
  const rightIconRef = React.useRef<HTMLSpanElement | null>(null)
  const [thumb, setThumb] = React.useState<{ left: number; top: number; width: number; height: number; radius: string }>({ left: 0, top: 0, width: 0, height: 0, radius: '8px' })
  const [segment, setSegment] = React.useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [spacing, setSpacing] = React.useState<{ containerPadding: number; buttonPadding: number; thumbInset: number }>({ containerPadding: 4, buttonPadding: 0, thumbInset: 2 })

  const measure = React.useCallback(() => {
    const container = containerRef.current
    const leftEl = leftRef.current
    const rightEl = rightRef.current
    const leftIconEl = leftIconRef.current
    const rightIconEl = rightIconRef.current
    if (!container || !leftEl || !rightEl || !leftIconEl || !rightIconEl) return

    // Measure icon dimensions to calculate proportional spacing
    const leftIconSize = Math.max(leftIconEl.offsetWidth, leftIconEl.offsetHeight)
    const rightIconSize = Math.max(rightIconEl.offsetWidth, rightIconEl.offsetHeight)
    const maxIconSize = Math.max(leftIconSize, rightIconSize)

    // Calculate proportional spacing (ratios chosen for visual balance)
    const calculatedButtonPadding = Math.round(maxIconSize * 0.3)
    const calculatedContainerPadding = Math.round(maxIconSize * 0.15)
    const calculatedThumbInset = thumbInset ?? Math.round(maxIconSize * 0.08)

    setSpacing({
      containerPadding: calculatedContainerPadding,
      buttonPadding: calculatedButtonPadding,
      thumbInset: calculatedThumbInset,
    })

    const activeEl = value === 0 ? leftEl : rightEl
    const cs = getComputedStyle(activeEl)
    const computedRadius = cs.borderRadius || '8px'
    const radius = thumbRadius ?? computedRadius
    const inset = calculatedThumbInset
    const segWidth = Math.max(leftEl.offsetWidth, rightEl.offsetWidth)
    const segHeight = Math.max(leftEl.offsetHeight, rightEl.offsetHeight)
    setSegment({ width: segWidth, height: segHeight })

    setThumb({
      left: activeEl.offsetLeft + inset,
      top: activeEl.offsetTop + inset,
      width: Math.max(0, activeEl.offsetWidth - inset * 2),
      height: Math.max(0, activeEl.offsetHeight - inset * 2),
      radius,
    })
  }, [value, thumbInset, thumbRadius])

  React.useLayoutEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    if (leftRef.current) ro.observe(leftRef.current)
    if (rightRef.current) ro.observe(rightRef.current)
    if (leftIconRef.current) ro.observe(leftIconRef.current)
    if (rightIconRef.current) ro.observe(rightIconRef.current)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const next = e.key === 'ArrowLeft' ? 0 : 1
      if (next !== value) onChange(next)
    }
  }

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="Two option toggle"
      className={cn(
        'relative inline-flex items-center rounded-md border border-input bg-muted/40 overflow-hidden',
        'outline-none focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px] transition-colors',
        className
      )}
      style={{ padding: spacing.containerPadding }}
      onKeyDown={handleKeyDown}
    >
      {/* Thumb */}
      <div
        aria-hidden
        className="pointer-events-none absolute bg-background shadow-sm transition-all duration-150 ease-out"
        style={{ left: thumb.left, top: thumb.top, width: thumb.width, height: thumb.height, borderRadius: thumb.radius }}
      />

      <button
        ref={leftRef}
        type="button"
        aria-pressed={value === 0}
        title={leftTitle}
        onClick={() => onChange(value === 0 ? 1 : 0)}
        className={cn(
          'relative z-10 inline-flex items-center justify-center rounded-[6px] text-muted-foreground',
          variant === 'fill' && 'flex-1',
          value === 0 && 'text-foreground'
        )}
        style={
          variant === 'content'
            ? { width: segment.width, height: segment.height, padding: spacing.buttonPadding }
            : { padding: spacing.buttonPadding }
        }
      >
        <span ref={leftIconRef} className="inline-flex">
          {leftIcon}
        </span>
      </button>
      <button
        ref={rightRef}
        type="button"
        aria-pressed={value === 1}
        title={rightTitle}
        onClick={() => onChange(value === 0 ? 1 : 0)}
        className={cn(
          'relative z-10 inline-flex items-center justify-center rounded-[6px] text-muted-foreground',
          variant === 'fill' && 'flex-1',
          value === 1 && 'text-foreground'
        )}
        style={
          variant === 'content'
            ? { width: segment.width, height: segment.height, padding: spacing.buttonPadding }
            : { padding: spacing.buttonPadding }
        }
      >
        <span ref={rightIconRef} className="inline-flex">
          {rightIcon}
        </span>
      </button>
    </div>
  )
}


