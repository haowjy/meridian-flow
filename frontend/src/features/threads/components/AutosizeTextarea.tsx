import { useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

const MIN_HEIGHT = 48  // ~2 lines
const MAX_HEIGHT = 200 // ~8 lines, then internal scroll

interface AutosizeTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    value: string
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
    onSubmit?: () => void
    canSend?: boolean
    /** Optional override for autosize clamp. Defaults to MIN_HEIGHT. */
    minHeight?: number | string
    /** Optional override for autosize clamp. Defaults to MAX_HEIGHT. */
    maxHeight?: number | string
    /** When this value changes, focus the textarea. Parent controls timing, component handles mechanics. */
    focusKey?: string | null
}

/**
 * Auto-expanding textarea with min/max height constraints.
 *
 * Expands as the user types, up to MAX_HEIGHT. Beyond that, content scrolls internally.
 * Works with absolute-positioned composer (outside scroll container) to prevent
 * browser caret-tracking from affecting the thread scroll position.
 */
export function AutosizeTextarea({
    value,
    onChange,
    onSubmit,
    canSend = true,
    minHeight = MIN_HEIGHT,
    maxHeight = MAX_HEIGHT,
    focusKey,
    className,
    ...props
}: AutosizeTextareaProps) {
    const ref = useRef<HTMLTextAreaElement | null>(null)

    // Focus when focusKey changes (parent controls timing, component handles mechanics)
    useEffect(() => {
        requestAnimationFrame(() => {
            try {
                ref.current?.focus({ preventScroll: true })
            } catch {
                // Older browsers may not support preventScroll
                ref.current?.focus()
            }
        })
    }, [focusKey])

    const minPx = typeof minHeight === 'number' ? minHeight : MIN_HEIGHT
    const maxPx = typeof maxHeight === 'number' ? maxHeight : MAX_HEIGHT

    // Auto-resize based on content, clamped between minPx and maxPx.
    // Only numeric maxHeight participates in JS clamping; string maxHeight relies on CSS.
    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return

        // Reset height to auto to measure actual scrollHeight
        el.style.height = 'auto'
        const next = Math.min(Math.max(el.scrollHeight, minPx), maxPx)
        el.style.height = `${next}px`
    }, [value, minPx, maxPx])

    return (
        <textarea
            ref={ref}
            rows={1}
            className={cn(
                // Auto-expanding with max height - scrolls internally when exceeded
                "overflow-y-auto",
                "w-full resize-none bg-transparent px-2 py-1.5 text-base md:text-sm",
                "placeholder:text-muted-foreground/60",
                "outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus:ring-offset-0",
                className
            )}
            style={{
                minHeight: typeof minHeight === 'number' ? minHeight : undefined,
                maxHeight: typeof maxHeight === 'number' ? maxHeight : maxHeight,
            }}
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
