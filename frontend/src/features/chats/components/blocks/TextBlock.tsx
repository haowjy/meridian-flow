import React from 'react'
import type { TurnBlock } from '@/features/chats/types'
import { Streamdown, defaultRehypePlugins } from 'streamdown'
import { cn } from '@/lib/utils'

interface TextBlockProps {
  block: TurnBlock
}

// Omit rehype-raw to prevent XML tags (e.g., <invoke>, <parameter>) from being
// interpreted as HTML elements. This can happen when LLM responses contain raw
// tool calling XML format.
const rehypePlugins = [
  defaultRehypePlugins.katex,
  defaultRehypePlugins.harden,
].filter(Boolean) as NonNullable<typeof defaultRehypePlugins.katex>[]

/**
 * Renders a text content block.
 *
 * This is the default block type for user and assistant messages.
 * Partial blocks (from interrupted streams) are shown with an amber indicator.
 */
export const TextBlock = React.memo(function TextBlock({ block }: TextBlockProps) {
  const text = block.textContent ?? ''
  const isPartial = block.status === 'partial'

  return (
    <div
      className={cn(
        'whitespace-pre-wrap overflow-hidden break-words',
        isPartial && 'border-l-2 border-amber-500 pl-2'
      )}
    >
      {isPartial && (
        <div className="text-xs text-amber-600 dark:text-amber-400 italic mb-1">
          Response was interrupted
        </div>
      )}
      <Streamdown rehypePlugins={rehypePlugins}>{text}</Streamdown>
    </div>
  )
})
