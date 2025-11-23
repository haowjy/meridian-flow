import React from 'react'
import type { TurnBlock } from '@/features/chats/types'
import { getBlockRenderer } from './registry'
import { BlockDebugButton } from './BlockDebugButton'

interface BlockRendererProps {
  block: TurnBlock
}

export const BlockRenderer = React.memo(function BlockRenderer({ block }: BlockRendererProps) {
  const renderBlock = getBlockRenderer(block.blockType)
  return (
    <div className="relative group">
      <BlockDebugButton block={block} />
      {renderBlock(block)}
    </div>
  )
})
