"use client"

import React, { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Turn } from '@/features/chats/types'
import { useChatStore } from '@/core/stores/useChatStore'
import { TurnActionBar } from './TurnActionBar'
import { BlockRenderer } from './blocks'
import { makeLogger } from '@/core/lib/logger'
import { buildAssistantRenderItems } from '@/features/chats/utils/toolGrouping'
import { ToolInteractionBlock } from './blocks/ToolInteractionBlock'

const log = makeLogger('AssistantTurn')

interface AssistantTurnProps {
  turn: Turn
}

/**
 * Assistant turn content.
 *
 * Single responsibility:
 * - Render assistant content as left-aligned blocks within the chat column.
 * - Handle actions (regenerate, navigate).
 *
 * The BlockRenderer pattern allows easy extension for new block types
 * (thinking, tool use, citations, etc.) without modifying this component.
 *
 * Performance: Memoized to prevent unnecessary re-renders when turn data unchanged.
 */
export const AssistantTurn = React.memo(function AssistantTurn({ turn }: AssistantTurnProps) {
  const { switchSibling, regenerateTurn, isLoadingTurns } = useChatStore(
    useShallow((s) => ({
      switchSibling: s.switchSibling,
      regenerateTurn: s.regenerateTurn,
      isLoadingTurns: s.isLoadingTurns,
    }))
  )

  log.debug('render', { id: turn.id, prevTurnId: turn.prevTurnId, blocks: turn.blocks.length })

  const handleNavigate = useCallback(
    (turnId: string) => {
      switchSibling(turn.chatId, turnId)
    },
    [switchSibling, turn.chatId]
  )

  const handleRegenerate = useCallback(() => {
    if (turn.prevTurnId) {
      regenerateTurn(turn.chatId, turn.prevTurnId)
    }
  }, [regenerateTurn, turn.chatId, turn.prevTurnId])

  const items = buildAssistantRenderItems(turn.blocks)

  return (
    <div className="flex flex-col items-stretch gap-1 group text-sm">
      <div className="w-full space-y-2">
        {items.map((item, index) => {
          if (item.kind === 'block') {
            return <BlockRenderer key={item.block.id} block={item.block} />
          }

          return (
            <ToolInteractionBlock
              key={item.toolUse?.id ?? item.toolResult?.id ?? `tool-${index}`}
              toolUse={item.toolUse}
              toolResult={item.toolResult}
            />
          )
        })}
      </div>

      <TurnActionBar
        turn={turn}
        isLast={false}
        isLoading={isLoadingTurns}
        onNavigate={handleNavigate}
        onRegenerate={turn.prevTurnId ? handleRegenerate : undefined}
        className="ml-0"
      />
    </div>
  )
})
