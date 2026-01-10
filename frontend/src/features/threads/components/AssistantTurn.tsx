import React, { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Turn, TurnBlock, ToolBlockContent } from '@/features/threads/types'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { TurnActionBar } from './TurnActionBar'
import { BlockRenderer } from './blocks'
import { InlineError } from '@/shared/components/InlineError'
import { makeLogger } from '@/core/lib/logger'
import { buildAssistantRenderItems } from '@/features/threads/utils/toolGrouping'
import { getToolRenderer } from './blocks/toolRegistry'

const log = makeLogger('AssistantTurn')

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract tool name from tool_use or tool_result block.
 * Used to route to appropriate custom tool UI via registry.
 */
function getToolName(
  toolUse: TurnBlock | null,
  toolResult: TurnBlock | null
): string | null {
  const source = toolUse ?? toolResult
  if (!source?.content) return null
  const content = source.content as ToolBlockContent
  return typeof content.tool_name === 'string' ? content.tool_name : null
}

// =============================================================================
// COMPONENT
// =============================================================================

interface AssistantTurnProps {
  turn: Turn
}

/**
 * Assistant turn content.
 *
 * Single responsibility:
 * - Render assistant content as left-aligned blocks within the thread column.
 * - Handle actions (regenerate, navigate).
 *
 * The BlockRenderer pattern allows easy extension for new block types
 * (thinking, tool use, citations, etc.) without modifying this component.
 *
 * Performance: Memoized to prevent unnecessary re-renders when turn data unchanged.
 */
export const AssistantTurn = React.memo(function AssistantTurn({ turn }: AssistantTurnProps) {
  const { switchSibling, regenerateTurn, isLoadingTurns } = useThreadStore(
    useShallow((s) => ({
      switchSibling: s.switchSibling,
      regenerateTurn: s.regenerateTurn,
      isLoadingTurns: s.isLoadingTurns,
    }))
  )

  log.debug('render', { id: turn.id, prevTurnId: turn.prevTurnId, blocks: turn.blocks.length })

  const handleNavigate = useCallback(
    (turnId: string) => {
      switchSibling(turn.threadId, turnId)
    },
    [switchSibling, turn.threadId]
  )

  const handleRegenerate = useCallback(() => {
    if (turn.prevTurnId) {
      regenerateTurn(turn.threadId, turn.prevTurnId)
    }
  }, [regenerateTurn, turn.threadId, turn.prevTurnId])

  const items = buildAssistantRenderItems(turn.blocks)

  return (
    <div className="flex flex-col items-stretch gap-1 group text-sm min-w-0" data-turn-id={turn.id}>
      <div className="w-full space-y-2 min-w-0 overflow-hidden">
        {items.map((item, index) => {
          if (item.kind === 'block') {
            return <BlockRenderer key={item.block.id} block={item.block} />
          }

          // Route to custom tool UI via registry (extensible pattern)
          const toolName = getToolName(item.toolUse, item.toolResult)
          const render = getToolRenderer(toolName)
          const key = item.toolUse?.id ?? item.toolResult?.id ?? `tool-${index}`

          return (
            <React.Fragment key={key}>
              {render(item.toolUse, item.toolResult)}
            </React.Fragment>
          )
        })}

        {/* Show turn-level error inline (no retry - most turn errors are config issues, not transient) */}
        {turn.error && (
          <InlineError message={turn.error} />
        )}
      </div>

      <TurnActionBar
        turn={turn}
        isLoading={isLoadingTurns}
        onNavigate={handleNavigate}
        onRegenerate={turn.prevTurnId ? handleRegenerate : undefined}
        className="ml-0"
      />
    </div>
  )
})
