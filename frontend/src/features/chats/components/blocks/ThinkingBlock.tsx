import React from 'react'
import type { TurnBlock } from '@/features/chats/types'
import { Streamdown } from 'streamdown'

interface ThinkingBlockProps {
  block: TurnBlock
}

/**
 * Renders a thinking block (Claude's internal reasoning).
 *
 * TODO: Implement collapsible thinking blocks for Claude's reasoning process.
 * This is a placeholder for future extended thinking feature.
 */
export const ThinkingBlock = React.memo(function ThinkingBlock({ block }: ThinkingBlockProps) {
  const text = block.textContent ?? ''

  return (
    <details className="my-2 border-l-2 border-muted-foreground/30 bg-muted/30 rounded text-sm text-muted-foreground">
      <summary className="cursor-pointer font-medium px-3 py-2">
        Thinking...
      </summary>
      <div className="mt-1 px-3 pb-3 whitespace-pre-wrap">
        <Streamdown>{text}</Streamdown>
      </div>
    </details>
  )
})
