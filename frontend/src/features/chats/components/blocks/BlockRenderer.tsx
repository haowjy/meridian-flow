import React from 'react'
import type { TurnBlock } from '@/features/chats/types'
import { getBlockRenderer } from './registry'

interface BlockRendererProps {
  block: TurnBlock
}

/**
 * BlockRenderer - Renders a turn block using the appropriate renderer from the registry.
 *
 * This component implements the Strategy pattern for block rendering, allowing
 * easy extension of new block types without modifying existing code.
 *
 * To add a new block type:
 * 1. Create a new block component (e.g., ToolUseBlock.tsx)
 * 2. Register it in blocks/registry.ts
 * 3. That's it! The BlockRenderer will automatically use it.
 *
 * Performance: Memoized to prevent unnecessary re-renders when block data unchanged.
 */
export const BlockRenderer = React.memo(function BlockRenderer({ block }: BlockRendererProps) {
  const Component = getBlockRenderer(block.blockType)
  return <Component block={block} />
})
