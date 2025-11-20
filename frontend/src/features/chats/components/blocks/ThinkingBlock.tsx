import React from 'react'
import type { TurnBlock } from '@/features/chats/types'

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
  return (
    <details className="my-2 p-3 border-l-2 border-muted-foreground/30 bg-muted/30 rounded text-sm text-muted-foreground">
      <summary className="cursor-pointer font-medium">Thinking...</summary>
      <div className="mt-2 whitespace-pre-wrap">{block.textContent}</div>
    </details>
  )
})
