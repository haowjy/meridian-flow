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
}

export function SegmentedIconToggle({
  value,
  onChange,
  leftIcon,
  rightIcon,
  className,
  leftTitle,
  rightTitle,
}: SegmentedIconToggleProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const leftRef = React.useRef<HTMLButtonElement | null>(null)
  const rightRef = React.useRef<HTMLButtonElement | null>(null)
  const [thumb, setThumb] = React.useState<{ left: number; width: number }>({ left: 0, width: 0 })

  const measure = React.useCallback(() => {
    if (!containerRef.current || !leftRef.current || !rightRef.current) return
    const containerRect = containerRef.current.getBoundingClientRect()
    const leftRect = leftRef.current.getBoundingClientRect()
    const rightRect = rightRef.current.getBoundingClientRect()
    const activeRect = value === 0 ? leftRect : rightRect
    setThumb({ left: activeRect.left - containerRect.left, width: activeRect.width })
  }, [value])

  React.useLayoutEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    if (leftRef.current) ro.observe(leftRef.current)
    if (rightRef.current) ro.observe(rightRef.current)
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
        'relative inline-flex items-center rounded-md border border-input bg-muted/40 p-1',
        'outline-none focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px] transition-colors',
        className
      )}
      onKeyDown={handleKeyDown}
    >
      {/* Thumb */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1 h-6 rounded-[6px] bg-background shadow-sm transition-all duration-150 ease-out"
        style={{ left: thumb.left, width: thumb.width }}
      />

      <button
        ref={leftRef}
        type="button"
        aria-pressed={value === 0}
        title={leftTitle}
        onClick={() => onChange(value === 0 ? 1 : 0)}
        className={cn(
          'relative z-10 inline-flex h-6 items-center justify-center rounded-[6px] px-1 text-muted-foreground',
          value === 0 && 'text-foreground'
        )}
      >
        {leftIcon}
      </button>
      <button
        ref={rightRef}
        type="button"
        aria-pressed={value === 1}
        title={rightTitle}
        onClick={() => onChange(value === 0 ? 1 : 0)}
        className={cn(
          'relative z-10 inline-flex h-6 items-center justify-center rounded-[6px] px-1 text-muted-foreground',
          value === 1 && 'text-foreground'
        )}
      >
        {rightIcon}
      </button>
    </div>
  )
}


