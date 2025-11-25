import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Loader2 } from 'lucide-react'
import type { TurnBlock } from '@/features/chats/types'
import { useChatStore } from '@/core/stores/useChatStore'
import { Streamdown, defaultRehypePlugins } from 'streamdown'

// Omit rehype-raw to prevent XML tags from being interpreted as HTML elements
const rehypePlugins = [
  defaultRehypePlugins.katex,
  defaultRehypePlugins.harden,
].filter(Boolean) as NonNullable<typeof defaultRehypePlugins.katex>[]

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

  const { streamingTurnId, streamingBlockIndex, streamingBlockType } = useChatStore(
    useShallow((s) => ({
      streamingTurnId: s.streamingTurnId,
      streamingBlockIndex: s.streamingBlockIndex,
      streamingBlockType: s.streamingBlockType,
    }))
  )

  const isStreamingThinking =
    streamingTurnId === block.turnId &&
    streamingBlockType === 'thinking' &&
    streamingBlockIndex === block.sequence

  return (
    <details className="my-2 border-l-2 border-muted-foreground/30 bg-muted/30 rounded text-sm text-muted-foreground">
      <summary className="cursor-pointer font-medium px-3 py-2">
        {isStreamingThinking && (
          <Loader2 className="mr-2 inline-block h-3 w-3 animate-spin" />
        )}
        Thinking...
      </summary>
      <div className="mt-1 px-3 pb-3 whitespace-pre-wrap">
        <Streamdown rehypePlugins={rehypePlugins}>{text}</Streamdown>
      </div>
    </details>
  )
})
