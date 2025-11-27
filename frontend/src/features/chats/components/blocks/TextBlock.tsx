import React from 'react'
import type { TurnBlock } from '@/features/chats/types'
import { Streamdown, defaultRehypePlugins } from 'streamdown'

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
 */
export const TextBlock = React.memo(function TextBlock({ block }: TextBlockProps) {
  const text = block.textContent ?? ''

  return (
    <div className="whitespace-pre-wrap overflow-hidden break-words">
      <Streamdown rehypePlugins={rehypePlugins}>{text}</Streamdown>
    </div>
  )
})
