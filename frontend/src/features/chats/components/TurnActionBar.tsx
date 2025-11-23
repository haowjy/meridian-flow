import React, { useState, useCallback, useMemo } from 'react'
import { Turn } from '@/features/chats/types'
import { ChevronLeft, ChevronRight, Edit2, RefreshCw, Copy, Check, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { makeLogger } from '@/core/lib/logger'
import { extractTextContent } from '@/features/chats/utils/turnHelpers'
import { DebugInfoDialog } from '@/core/components/DebugInfoDialog'

const log = makeLogger('TurnActionBar')

interface TurnActionBarProps {
    turn: Turn
    isLoading?: boolean
    onNavigate: (turnId: string) => void
    onEdit?: () => void
    onRegenerate?: () => void
    className?: string
}

/**
 * Action bar for turn navigation and operations.
 *
 * Performance: Memoized to prevent unnecessary re-renders.
 * Event handlers are wrapped in useCallback to maintain referential equality.
 */
export const TurnActionBar = React.memo(function TurnActionBar({
    turn,
    isLoading = false,
    onNavigate,
    onEdit,
    onRegenerate,
    className,
}: TurnActionBarProps) {
    const [copied, setCopied] = useState(false)
    const [showDebug, setShowDebug] = useState(false)
    const isDevMode = process.env.NEXT_PUBLIC_DEV_TOOLS === '1'

    // Memoize sibling calculations to avoid recalculating on every render
    const { siblingList, siblingCount, currentIndex, currentNumber, showNavigation } = useMemo(() => {
        // Server may or may not include the current turn ID in siblingIds.
        // Build a stable list that always contains the current turn first if missing.
        const siblingIdsRaw = turn.siblingIds || []
        const siblingList = siblingIdsRaw.includes(turn.id) ? siblingIdsRaw : [turn.id, ...siblingIdsRaw]
        const siblingCount = siblingList.length
        const currentIndex = siblingList.indexOf(turn.id)
        // If not found (shouldn't happen if data is consistent), default to 0/0 or hide
        const currentNumber = currentIndex !== -1 ? currentIndex + 1 : 1
        const showNavigation = siblingCount > 1

        return { siblingList, siblingCount, currentIndex, currentNumber, showNavigation }
    }, [turn.id, turn.siblingIds])

    const handleCopy = useCallback(async () => {
        try {
            const content = extractTextContent(turn)
            await navigator.clipboard.writeText(content)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch (err) {
            log.error('Failed to copy text', err)
        }
    }, [turn])

    const handlePrev = useCallback(() => {
        if (currentIndex > 0) {
            const prevId = siblingList[currentIndex - 1]
            if (prevId) onNavigate(prevId)
        }
    }, [currentIndex, siblingList, onNavigate])

    const handleNext = useCallback(() => {
        if (currentIndex < siblingCount - 1) {
            const nextId = siblingList[currentIndex + 1]
            if (nextId) onNavigate(nextId)
        }
    }, [currentIndex, siblingCount, siblingList, onNavigate])

    // Prepare debug metadata
    const debugData = useMemo(() => ({
        id: turn.id,
        chatId: turn.chatId,
        prevTurnId: turn.prevTurnId,
        role: turn.role,
        status: turn.status,
        error: turn.error,
        model: turn.model,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        createdAt: turn.createdAt.toISOString(),
        completedAt: turn.completedAt?.toISOString(),
        lastAccessedAt: turn.lastAccessedAt?.toISOString(),
        siblingIds: turn.siblingIds,
        blockCount: turn.blocks.length,
    }), [turn])

    return (
        <div className={cn('flex items-center gap-2 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200', className)}>
            <div className="flex items-center gap-1">
                <button
                    onClick={handleCopy}
                    className="p-1 rounded cursor-pointer hover:bg-muted/60 hover:text-foreground transition-colors"
                    aria-label="Copy text"
                >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </button>

                {onEdit && (
                    <button
                        onClick={onEdit}
                        className="p-1 rounded cursor-pointer hover:bg-muted/60 hover:text-foreground transition-colors"
                        aria-label="Edit message"
                    >
                        <Edit2 className="w-3.5 h-3.5" />
                    </button>
                )}

                {onRegenerate && (
                    <button
                        onClick={onRegenerate}
                        className="p-1 rounded cursor-pointer hover:bg-muted/60 hover:text-foreground transition-colors"
                        aria-label="Regenerate response"
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                )}

                {isDevMode && (
                    <button
                        onClick={() => setShowDebug(true)}
                        className="p-1 rounded cursor-pointer hover:bg-muted/60 hover:text-foreground transition-colors"
                        aria-label="Debug info"
                    >
                        <Info className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {showNavigation && (
                <div className="flex items-center gap-0 ml-1 text-muted-foreground/60">
                    <button
                        onClick={handlePrev}
                        disabled={currentIndex === 0 || isLoading}
                        className="px-0.5 py-0.5 rounded cursor-pointer hover:bg-muted/60 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        aria-label="Previous version"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="px-0 text-[10px] font-medium text-center select-none">
                        {currentNumber}/{siblingCount}
                    </span>
                    <button
                        onClick={handleNext}
                        disabled={currentIndex === siblingCount - 1 || isLoading}
                        className="px-0.5 py-0.5 rounded cursor-pointer hover:bg-muted/60 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        aria-label="Next version"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </div>
            )}

            {isDevMode && (
                <DebugInfoDialog
                    isOpen={showDebug}
                    onClose={() => setShowDebug(false)}
                    title={`Turn Debug: ${turn.role}`}
                    data={debugData}
                />
            )}
        </div>
    )
})
