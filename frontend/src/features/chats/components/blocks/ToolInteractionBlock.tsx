import React, { useState } from 'react'
import type { ToolBlockContent, TurnBlock } from '@/features/chats/types'

interface ToolInteractionBlockProps {
  toolUse: TurnBlock | null
  toolResult: TurnBlock | null
}

function getToolMeta(toolUse: TurnBlock | null, toolResult: TurnBlock | null) {
  const source = toolResult ?? toolUse
  const content = (source?.content ?? {}) as ToolBlockContent
  const toolName =
    typeof content.tool_name === 'string' ? content.tool_name : 'Tool'
  const toolUseId =
    typeof content.tool_use_id === 'string' ? content.tool_use_id : null
  const isError = typeof content.is_error === 'boolean' ? content.is_error : false

  return { toolName, toolUseId, isError }
}

function buildCallPreview(
  toolName: string,
  toolUse: TurnBlock | null,
  toolResult: TurnBlock | null
): string | null {
  const source = toolUse ?? toolResult
  const content = (source?.content ?? {}) as ToolBlockContent
  const input = content.input

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

/**
 * Combined visual for tool_use + tool_result with the same tool_use_id.
 *
 * Phase 1: compact header-only representation so tool interactions
 * don't dominate the chat. Details/JSON can be added in a future expansion.
 */
export const ToolInteractionBlock = React.memo(function ToolInteractionBlock({
  toolUse,
  toolResult,
}: ToolInteractionBlockProps) {
  const { toolName, toolUseId, isError } = getToolMeta(toolUse, toolResult)
  const hasResult = !!toolResult

  const shortId = toolUseId ? `${toolUseId.slice(0, 8)}…` : null
  const callPreview = buildCallPreview(toolName, toolUse, toolResult)
  const title = callPreview ?? (shortId ? `${toolName} (${shortId})` : toolName)

  const [isExpanded, setIsExpanded] = useState(false)

  let statusLabel: string
  if (isError) {
    statusLabel = 'Error'
  } else if (hasResult) {
    statusLabel = 'Success'
  } else {
    statusLabel = 'Waiting for result…'
  }

  return (
    <div className="my-1 rounded border border-dashed border-muted-foreground/40 bg-muted/40 text-xs flex flex-col">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left cursor-pointer hover:bg-muted/60 transition-colors"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-muted-foreground">
              {title}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/80">
            <span className={isError ? 'text-destructive' : undefined}>{statusLabel}</span>
          </div>
        </div>

        <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/80">
          Tool
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-muted-foreground/20 px-3 py-1.5 space-y-1.5 text-[11px] text-muted-foreground">
          {toolUse && (toolUse.content as ToolBlockContent)?.input && (
            <div>
              <div className="mb-0.5 font-medium text-muted-foreground/80">Call</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background/60 px-2 py-1">
                {JSON.stringify((toolUse.content as ToolBlockContent).input ?? {}, null, 2)}
              </pre>
            </div>
          )}

          {toolResult && (
            <div>
              <div className="mb-0.5 font-medium text-muted-foreground/80">Result</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background/60 px-2 py-1">
                {JSON.stringify(toolResult.content ?? {}, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
