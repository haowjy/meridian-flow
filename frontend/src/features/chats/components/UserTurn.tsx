import React, { useState, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Turn, ChatRequestOptions } from '@/features/chats/types'
import { cn } from '@/lib/utils'
import { Card } from '@/shared/components/ui/card'
import { TurnActionBar } from './TurnActionBar'
import { EditTurnDialog } from './EditTurnDialog'
import { BlockRenderer } from './blocks'
import { useChatStore } from '@/core/stores/useChatStore'
import { makeLogger } from '@/core/lib/logger'
import { extractTextContent } from '@/features/chats/utils/turnHelpers'

const log = makeLogger('UserTurn')

interface UserTurnProps {
  turn: Turn
}

/**
 * User turn bubble.
 *
 * Single responsibility:
 * - Render a user-authored turn as a right-aligned bubble using BlockRenderer.
 * - Handle actions (edit, navigate).
 *
 * The BlockRenderer pattern allows easy extension for new block types
 * without modifying this component.
 *
 * Performance: Memoized to prevent unnecessary re-renders when turn data unchanged.
 */
export const UserTurn = React.memo(function UserTurn({ turn }: UserTurnProps) {
  const [isEditing, setIsEditing] = useState(false)
  const { switchSibling, editTurn, isLoadingTurns } = useChatStore(
    useShallow((s) => ({
      switchSibling: s.switchSibling,
      editTurn: s.editTurn,
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

  const handleSaveEdit = useCallback(
    async (newMessageText: string, options: ChatRequestOptions) => {
      await editTurn(turn.chatId, turn.id, newMessageText, options)
      setIsEditing(false)
    },
    [editTurn, turn.chatId, turn.id]
  )

  const handleEdit = useCallback(() => {
    setIsEditing(true)
  }, [])

  const handleCloseEdit = useCallback(() => {
    setIsEditing(false)
  }, [])

  return (
    <div className="group flex flex-col items-end gap-1 text-sm min-w-0" data-turn-id={turn.id}>
      {isEditing ? (
        <EditTurnDialog
          isOpen={isEditing}
          onClose={handleCloseEdit}
          initialContent={extractTextContent(turn)}
          originalRequestParams={turn.requestParams}
          onSave={handleSaveEdit}
        />
      ) : (
        <>
          <Card className={cn('px-3 py-2', 'chat-message chat-message--user')}>
            {turn.blocks.map((block) => (
              <BlockRenderer key={block.id} block={block} />
            ))}
          </Card>

          <TurnActionBar
            turn={turn}
            isLoading={isLoadingTurns}
            onNavigate={handleNavigate}
            onEdit={handleEdit}
            className="mr-1"
          />
        </>
      )}
    </div>
  )
})
