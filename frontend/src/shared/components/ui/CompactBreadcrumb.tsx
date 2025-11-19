import { Fragment } from 'react'
import { cn } from '@/lib/utils'

export interface BreadcrumbSegment {
    label: string
    onClick?: () => void
    title?: string
}

type SingleSegmentVariant = 'last' | 'nonLast'

interface CompactBreadcrumbProps {
    segments: BreadcrumbSegment[]
    className?: string
    /**
     * Controls how a single segment (when it's both first and last) should be styled.
     * - 'last' (default): font-medium text-foreground
     * - 'nonLast': font-semibold text-muted-foreground
     */
    singleSegmentVariant?: SingleSegmentVariant
}

/**
 * Shared compact breadcrumb component.
 * 
 * Layout: Segment / Segment / ... / LastSegment
 * Style: 
 *  - Container: flex items-center gap-2 text-sm
 *  - Non-last: text-muted-foreground font-semibold
 *  - Last: text-foreground font-medium
 *  - Separator: text-muted-foreground/70
 */
export function CompactBreadcrumb({ segments, className, singleSegmentVariant = 'last' }: CompactBreadcrumbProps) {
    if (!segments.length) return null
    const isSingleSegment = segments.length === 1
    const nonLastTextClass = "font-semibold text-muted-foreground"
    const lastTextClass = "font-medium text-foreground"
    const singleSegmentClass = singleSegmentVariant === 'nonLast' ? nonLastTextClass : lastTextClass

    const getSegmentTone = (isLast: boolean) => {
        if (isSingleSegment) {
            return singleSegmentClass
        }

        return isLast ? lastTextClass : nonLastTextClass
    }

    return (
        <div className={cn("flex min-w-0 items-center gap-2 text-sm", className)}>
            {segments.map((segment, index) => {
                const isLast = index === segments.length - 1
                const segmentTone = getSegmentTone(isLast)

                return (
                    <Fragment key={index}>
                        {index > 0 && (
                            <span className="text-muted-foreground/70" aria-hidden="true">/</span>
                        )}

                        {segment.onClick && !isLast ? (
                            <button
                                type="button"
                                onClick={segment.onClick}
                                className={cn(
                                    "cursor-pointer truncate hover:underline focus-visible:underline focus:outline-none",
                                    segmentTone
                                )}
                                title={segment.title}
                            >
                                {segment.label}
                            </button>
                        ) : (
                            <span
                                className={cn("truncate", segmentTone)}
                                title={segment.title}
                            >
                                {segment.label}
                            </span>
                        )}
                    </Fragment>
                )
            })}
        </div>
    )
}
