/**
 * ToolInteractionBlock - Generic visual for tool_use + tool_result blocks
 *
 * Combined representation for tool interactions with:
 * - Collapsible header showing tool name and call preview
 * - Status badge (Preparing/Running/Success/Error)
 * - Expandable content showing call input and result
 *
 * Uses CollapsibleToolBlock for consistent styling with other tool blocks.
 */

import React, { useState } from 'react'
import { Wrench, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolBlockContent, TurnBlock } from '@/features/threads/types'
import { ToolStreamState } from '@/features/threads/stores/useToolStreamStore'
import { normalizeToolCallId } from '@/features/threads/utils/normalizeToolCallId'
import { safeJsonStringify } from '@/features/threads/utils/safeJsonStringify'
import {
  CollapsibleToolBlock,
  ToolStatusBadge,
  useToolStreamingState,
  type ToolStatus,
} from './shared'

interface ToolInteractionBlockProps {
  toolUse: TurnBlock | null
  toolResult: TurnBlock | null
}

function getToolMeta(
  toolUse: TurnBlock | null,
  toolResult: TurnBlock | null,
  streamingToolName?: string | null,
  streamingToolUseId?: string
) {
  const source = toolResult ?? toolUse
  const content = (source?.content ?? {}) as ToolBlockContent

  // Prefer streaming state, fallback to block content
  // Return null if no tool name available (will show "Pending" state)
  const toolName = streamingToolName
    ?? (typeof content.tool_name === 'string' ? content.tool_name : null)
  const toolUseIdRaw = streamingToolUseId
    ?? (typeof content.tool_use_id === 'string' ? content.tool_use_id : null)
  const toolUseId = typeof toolUseIdRaw === 'string' ? normalizeToolCallId(toolUseIdRaw) : toolUseIdRaw
  const isError = typeof content.is_error === 'boolean' ? content.is_error : false

  return { toolName, toolUseId, isError }
}

function buildCallPreview(
  toolName: string,
  toolUse: TurnBlock | null,
  toolResult: TurnBlock | null,
  streamingInput?: Record<string, unknown>
): string | null {
  const source = toolUse ?? toolResult
  const content = (source?.content ?? {}) as ToolBlockContent
  // Use streaming input if available, fallback to block content
  const input = streamingInput ?? content.input

  if (!input || typeof input !== 'object') {
    return null
  }

  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null
  )
  if (entries.length === 0) {
    return `${toolName}()`
  }

  const formatValue = (value: unknown): string => {
    if (typeof value === 'string') {
      const safe = value.replace(/"/g, '\\"')
      return `"${safe}"`
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    // Complex objects/arrays – keep compact
    return '…'
  }

  const parts = entries.slice(0, 2).map(([key, value]) => `${key}=${formatValue(value)}`)
  const inner = parts.join(', ')
  const raw = `${toolName}(${inner})`

  const limit = 96
  return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw
}

export const ToolInteractionBlock = React.memo(function ToolInteractionBlock({
  toolUse,
  toolResult,
}: ToolInteractionBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Get streaming state via dedicated hook
  const {
    state: toolState,
    toolName: streamingToolName,
    input: streamingInput,
    argsTotalBytes,
    activeArgKey,
    activeArgChars,
    activeArgPreviewHead,
    activeArgPreviewTail,
  } = useToolStreamingState({
    blockContent: toolUse?.content as ToolBlockContent | undefined,
  })

  // Get tool_use_id from block content for display
  const blockToolUseId = (toolUse?.content as ToolBlockContent)?.tool_use_id

  const { toolName, toolUseId, isError } = getToolMeta(
    toolUse,
    toolResult,
    streamingToolName,
    typeof blockToolUseId === 'string' ? blockToolUseId : undefined
  )
  const hasResult = !!toolResult

  // If no tool name yet, show pending state instead of "unknown"
  const isPending = !toolName
  const displayName = toolName ?? 'Tool'

  const shortId = toolUseId ? `${toolUseId.slice(0, 8)}…` : null
  const callPreview = isPending ? null : buildCallPreview(displayName, toolUse, toolResult, streamingInput ?? undefined)
  const title = isPending ? 'Pending...' : (callPreview ?? (shortId ? `${displayName} (${shortId})` : displayName))

  // Get error message from result
  const errorMessage = isError && toolResult
    ? (typeof (toolResult.content as ToolBlockContent)?.message === 'string'
      ? (toolResult.content as ToolBlockContent).message as string
      : typeof (toolResult.content as ToolBlockContent)?.error === 'string'
        ? (toolResult.content as ToolBlockContent).error as string
        : undefined)
    : undefined

  // Determine status and label
  let status: ToolStatus
  let statusLabel: string
  if (isError) {
    status = 'error'
    statusLabel = 'Error'
  } else if (hasResult) {
    status = 'success'
    statusLabel = 'Success'
  } else if (toolState === ToolStreamState.EXECUTING) {
    status = 'pending'
    statusLabel = 'Running...'
  } else if (toolState === ToolStreamState.PREPARING) {
    status = 'pending'
    statusLabel = 'Preparing...'
  } else if (toolState === ToolStreamState.READY) {
    status = 'pending'
    statusLabel = 'Ready'
  } else {
    status = 'pending'
    statusLabel = 'Pending...'
  }

  // Determine animation states
  // isGenerating: shimmer during PREPARING (args streaming) or when pending (no state yet)
  const isGenerating = !hasResult && !isError && (toolState === null || toolState === ToolStreamState.PREPARING)
  // isExecuting: pulse during EXECUTING (tool running server-side)
  const isExecuting = !hasResult && !isError && toolState === ToolStreamState.EXECUTING

  const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb.toFixed(1)} KB`
    const mb = kb / 1024
    return `${mb.toFixed(1)} MB`
  }

  return (
    <CollapsibleToolBlock
      icon={Wrench}
      label={
        <span className="text-sm font-medium text-foreground/90 truncate min-w-0">
          {title}
        </span>
      }
      statusBadge={<ToolStatusBadge status={status} label={statusLabel} />}
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      isGenerating={isGenerating}
      isExecuting={isExecuting}
    >
      {/* Streaming arg progress (best-effort) */}
      {!hasResult && !isError && toolState === ToolStreamState.PREPARING && activeArgKey && (
        <div className="rounded-md border bg-muted/20 px-2.5 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 truncate">
              Streaming <span className="font-medium">{activeArgKey}</span>
              {typeof activeArgChars === 'number' ? (
                <span className="text-muted-foreground/80"> ({activeArgChars.toLocaleString()} chars)</span>
              ) : null}
            </div>
            <div className="shrink-0 text-muted-foreground/80">
              {typeof argsTotalBytes === 'number' ? formatBytes(argsTotalBytes) : null}
            </div>
          </div>
          {(activeArgPreviewHead || activeArgPreviewTail) && (
            <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 px-2 py-1.5 text-xs">
              {activeArgPreviewHead}
              {activeArgPreviewTail && activeArgPreviewTail !== activeArgPreviewHead ? (
                <>
                  {'\n…\n'}
                  {activeArgPreviewTail}
                </>
              ) : null}
            </pre>
          )}
        </div>
      )}

      {/* Error message */}
      {isError && errorMessage && (
        <div
          className={cn(
            'flex items-start gap-2',
            'text-xs p-2.5 rounded-md',
            'bg-error/15 text-error'
          )}
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="leading-relaxed">{errorMessage}</span>
        </div>
      )}

      {/* Tool call input */}
      {toolUse && (toolUse.content as ToolBlockContent)?.input && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground/80">Call</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 px-2.5 py-2 text-xs">
            {safeJsonStringify((toolUse.content as ToolBlockContent).input ?? {})}
          </pre>
        </div>
      )}

      {/* Tool result */}
      {toolResult && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground/80">Result</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 px-2.5 py-2 text-xs">
            {safeJsonStringify(toolResult.content ?? {})}
          </pre>
        </div>
      )}
    </CollapsibleToolBlock>
  )
})
