"use client"

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

interface AutosizeTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    value: string
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
    onSubmit?: () => void
    canSend?: boolean
    maxHeight?: number | string
    minHeight?: number | string
    /** When this value changes, focus the textarea. Parent controls timing, component handles mechanics. */
    focusKey?: string | null
}

export function AutosizeTextarea({
    value,
    onChange,
    onSubmit,
    canSend = true,
    maxHeight = 240,
    minHeight = '3rem',
    focusKey,
    className,
    ...props
}: AutosizeTextareaProps) {
    const ref = useRef<HTMLTextAreaElement | null>(null)

    // Focus when focusKey changes (parent controls timing, component handles mechanics)
    useEffect(() => {
        requestAnimationFrame(() => {
            ref.current?.focus()
        })
    }, [focusKey])

    useEffect(() => {
        const el = ref.current
        if (!el) return

        el.style.height = 'auto'

        // Handle numeric or string max-height
        let limitPx = Infinity
        if (typeof maxHeight === 'number') {
            limitPx = maxHeight
        } else if (typeof maxHeight === 'string' && maxHeight.endsWith('px')) {
            limitPx = parseInt(maxHeight, 10)
        } else if (typeof maxHeight === 'string' && maxHeight.endsWith('vh')) {
            // Approximate vh to px for calculation if needed, or rely on CSS max-height
            // For scrollHeight calculation, we need a pixel limit to know when to stop growing.
            // If it's vh, we can check window.innerHeight
            const vh = parseInt(maxHeight, 10)
            limitPx = (window.innerHeight * vh) / 100
        }

        const next = Math.min(el.scrollHeight, limitPx)
        el.style.height = `${next}px`

        // Also set max-height style to ensure CSS overflow kicks in if we hit the limit
        el.style.maxHeight = typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight

    }, [value, maxHeight])

    return (
        <textarea
            ref={ref}
            rows={1}
            className={cn(
                "w-full resize-none bg-transparent px-2 pt-1 pb-1 text-sm outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus:ring-offset-0",
                className
            )}
            style={{ minHeight: typeof minHeight === 'number' ? `${minHeight}px` : minHeight }}
            value={value}
            onChange={onChange}
            onKeyDown={(event) => {
                if (onSubmit && event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    if (canSend) onSubmit()
                }
                props.onKeyDown?.(event)
            }}
            {...props}
        />
    )
}
