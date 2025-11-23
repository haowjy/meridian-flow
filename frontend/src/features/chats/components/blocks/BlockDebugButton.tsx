"use client"

import { useState } from 'react'
import { Info } from 'lucide-react'
import type { TurnBlock } from '@/features/chats/types'
import { DebugInfoDialog } from '@/core/components/DebugInfoDialog'

interface BlockDebugButtonProps {
  block: TurnBlock
}

/**
 * Debug button for blocks.
 *
 * Floats in top-right corner of each block.
 * Only rendered when NEXT_PUBLIC_DEV_TOOLS=1.
 */
export function BlockDebugButton({ block }: BlockDebugButtonProps) {
  const [showDebug, setShowDebug] = useState(false)
  const isDevMode = process.env.NEXT_PUBLIC_DEV_TOOLS === '1'

  if (!isDevMode) {
    return null
  }

  const debugData = {
    id: block.id,
    turnId: block.turnId,
    blockType: block.blockType,
    sequence: block.sequence,
  }

  return (
    <>
      <button
        onClick={() => setShowDebug(true)}
        className="absolute top-1 right-1 z-10 p-1 rounded bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
        aria-label="Block debug info"
      >
        <Info className="w-3 h-3" />
      </button>

      <DebugInfoDialog
        isOpen={showDebug}
        onClose={() => setShowDebug(false)}
        title={`Block Debug: ${block.blockType}`}
        data={debugData}
      />
    </>
  )
}
