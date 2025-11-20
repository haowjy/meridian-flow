import React from 'react'
import type { TurnBlock } from '@/features/chats/types'

interface TextBlockProps {
  block: TurnBlock
}

/**
 * Renders a text content block.
 *
 * This is the default block type for user and assistant messages.
 */
export const TextBlock = React.memo(function TextBlock({ block }: TextBlockProps) {
  return <div className="whitespace-pre-wrap">{block.textContent}</div>
})
