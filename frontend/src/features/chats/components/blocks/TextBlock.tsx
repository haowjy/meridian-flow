import React from 'react'
import type { TurnBlock } from '@/features/chats/types'
import { Streamdown } from 'streamdown'

interface TextBlockProps {
  block: TurnBlock
}

/**
 * Renders a text content block.
 *
 * This is the default block type for user and assistant messages.
 */
export const TextBlock = React.memo(function TextBlock({ block }: TextBlockProps) {
  const text = block.textContent ?? ''

  return (
    <div className="whitespace-pre-wrap">
      <Streamdown>{text}</Streamdown>
    </div>
  )
})
