/**
 * useToolStreamingState - Clean hook for component consumption of tool streaming state
 *
 * Abstracts the store internals and provides a stable API for tool block components.
 * Components should use this hook instead of directly accessing the store.
 */

import { useMemo } from 'react'
import { useToolStreamStore, ToolStreamState } from '@/features/threads/stores/useToolStreamStore'
import type { ToolBlockContent } from '@/features/threads/types'
import { normalizeToolCallId } from '@/features/threads/utils/normalizeToolCallId'

interface UseToolStreamingStateOptions {
  /** The block content containing toolUseId */
  blockContent?: ToolBlockContent
  /** Direct tool call ID (alternative to blockContent) */
  toolCallId?: string
}

interface ToolStreamingStateResult {
  /** Current state string (preparing, ready, executing, complete, error) */
  state: string | null
  /** Tool name from streaming state */
  toolName: string | null
  /** Accumulated input from JSON deltas */
  input: Record<string, unknown> | null
  /** Total bytes received for TOOL_CALL_ARGS (best-effort) */
  argsTotalBytes: number | null
  /** True when args JSON buffer was truncated (UI safety) */
  argsJsonTruncated: boolean
  /** Best-effort currently streaming top-level arg key (string values only) */
  activeArgKey: string | null
  /** Best-effort chars received for the active arg value */
  activeArgChars: number | null
  /** Small head preview of the active arg value */
  activeArgPreviewHead: string | null
  /** Small tail preview of the active arg value */
  activeArgPreviewTail: string | null
  /** True if tool is in any streaming state (preparing or ready, not yet complete) */
  isStreaming: boolean
  /** True if args are still being generated (preparing state) */
  isGenerating: boolean
  /** True if tool has completed */
  isComplete: boolean
  /** Error message if in error state */
  error: string | null
}

/**
 * Hook for accessing tool streaming state in components.
 *
 * @example
 * ```tsx
 * const { isGenerating, input, state } = useToolStreamingState({
 *   blockContent: toolUse?.content as ToolBlockContent
 * })
 *
 * // Use isGenerating for shimmer animations
 * // Use input for progressive display of tool args
 * ```
 */
export function useToolStreamingState(
  opts: UseToolStreamingStateOptions
): ToolStreamingStateResult {
  // Resolve toolCallId from either direct prop or block content
  const rawToolCallId = opts.toolCallId ?? opts.blockContent?.toolUseId
  const toolCallId = typeof rawToolCallId === 'string' ? normalizeToolCallId(rawToolCallId) : rawToolCallId

  // Subscribe to the specific tool's state
  const toolData = useToolStreamStore((s) =>
    typeof toolCallId === 'string' ? s.tools[toolCallId] : undefined
  )

  // Derive computed values
  return useMemo(() => {
    if (!toolData) {
      return {
        state: null,
        toolName: null,
        input: null,
        argsTotalBytes: null,
        argsJsonTruncated: false,
        activeArgKey: null,
        activeArgChars: null,
        activeArgPreviewHead: null,
        activeArgPreviewTail: null,
        isStreaming: false,
        isGenerating: false,
        isComplete: false,
        error: null,
      }
    }

    const isStreaming =
      toolData.state === ToolStreamState.PREPARING ||
      toolData.state === ToolStreamState.READY ||
      toolData.state === ToolStreamState.EXECUTING

    const isGenerating = toolData.state === ToolStreamState.PREPARING

    const isComplete =
      toolData.state === ToolStreamState.COMPLETE ||
      toolData.state === ToolStreamState.ERROR

    return {
      state: toolData.state,
      toolName: toolData.toolName,
      input: toolData.input ?? null,
      argsTotalBytes: typeof toolData.argsTotalBytes === 'number' ? toolData.argsTotalBytes : null,
      argsJsonTruncated: toolData.argsJsonTruncated === true,
      activeArgKey: typeof toolData.activeArgKey === 'string' ? toolData.activeArgKey : null,
      activeArgChars: typeof toolData.activeArgChars === 'number' ? toolData.activeArgChars : null,
      activeArgPreviewHead: typeof toolData.activeArgPreviewHead === 'string' ? toolData.activeArgPreviewHead : null,
      activeArgPreviewTail: typeof toolData.activeArgPreviewTail === 'string' ? toolData.activeArgPreviewTail : null,
      isStreaming,
      isGenerating,
      isComplete,
      error: toolData.error ?? null,
    }
  }, [toolData])
}
