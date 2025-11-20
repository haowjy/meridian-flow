"use client"

import React, { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Turn } from '@/features/chats/types'
import { Card } from '@/shared/components/ui/card'
import { useChatStore } from '@/core/stores/useChatStore'
import { TurnActionBar } from './TurnActionBar'
import { BlockRenderer } from './blocks'
import { makeLogger } from '@/core/lib/logger'

const log = makeLogger('AssistantTurn')

interface AssistantTurnProps {
  turn: Turn
}

/**
 * Assistant turn bubble.
 *
 * Single responsibility:
 * - Render assistant content as a left-aligned bubble using BlockRenderer.
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

  return (
    <div className="flex flex-col items-start gap-1 group">
      <Card className="max-w-3xl px-3 py-2 text-sm chat-message chat-message--ai">
        {turn.blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} />
        ))}
      </Card>

      <TurnActionBar
        turn={turn}
        isLast={false}
        isLoading={isLoadingTurns}
        onNavigate={handleNavigate}
        onRegenerate={turn.prevTurnId ? handleRegenerate : undefined}
        className="ml-1"
      />
    </div>
  )
})
