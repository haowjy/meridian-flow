/**
 * Tool Event Handlers
 *
 * Handles TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END events.
 * These events stream tool call arguments progressively from the LLM.
 */

import { parse as parsePartialJson, STR, OBJ, ARR, NUM } from 'partial-json'
import { ToolStreamState } from '@/features/threads/stores/useToolStreamStore'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { normalizeToolCallId } from '@/features/threads/utils/normalizeToolCallId'
import type { SSEDispatchContext, SSEStoreActions } from '../types'
import type {
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
} from '../../sseEventTypes'

const MAX_TOOL_JSON_BUFFER_CHARS = 64_000
const MAX_TOOL_ARGS_PARSE_CHARS = 16_000

/**
 * Handle TOOL_CALL_START event.
 * Creates skeleton block and initializes streaming tool state.
 */
export function handleToolCallStart(
  data: ToolCallStartEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions
): void {
  const { tracker, logger, buffer } = ctx
  const toolCallId = normalizeToolCallId(data.toolCallId)

  // Tool calls can start before TEXT_MESSAGE_END arrives. Flush any buffered text/thinking
  // so the UI reflects "text finished" before the tool block appears.
  buffer.flush()

  // Get next block index and register the tool call
  const blockIndex = tracker.nextBlockIndex()
  tracker.setCurrentBlockType('tool_use')
  tracker.registerToolCall(toolCallId, blockIndex)

  // Initialize streaming tool state (keyed by toolCallId for stable lookup)
  actions.updateToolState(toolCallId, {
    state: ToolStreamState.PREPARING,
    toolName: data.toolCallName,
    toolUseId: toolCallId,
    toolCallId,
    blockIndex,
    argsTotalBytes: 0,
    argsJsonTruncated: false,
    activeArgKey: null,
    activeArgChars: 0,
    activeArgPreviewHead: '',
    activeArgPreviewTail: '',
  })

  // Create skeleton block for tool_use so rendering pipeline works
  actions.setStreamingBlockContent(ctx.turnId, blockIndex, 'tool_use', {
    tool_name: data.toolCallName,
    tool_use_id: toolCallId,
    input: {},
  })

  // Update streaming block info
  actions.setStreamingBlockInfo(blockIndex, 'tool_use')

  logger.debug('sse:TOOL_CALL_START', {
    toolCallId,
    toolName: data.toolCallName,
    blockIndex,
  })
}

/**
 * Handle TOOL_CALL_ARGS event.
 * Accumulates JSON delta and parses partial JSON for progressive display.
 */
export function handleToolCallArgs(
  data: ToolCallArgsEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions
): void {
  const { tracker, logger } = ctx
  const toolCallId = normalizeToolCallId(data.toolCallId)

  const blockIndex = tracker.getToolCallBlockIndex(toolCallId)
  if (blockIndex === undefined) {
    logger.warn('sse:TOOL_CALL_ARGS:no_block', { toolCallId })
    return
  }

  // Update lightweight streaming metadata (active arg key + preview) without parsing full JSON
  const streamMeta = tracker.appendToolArgsDelta(toolCallId, data.delta)
  if (streamMeta) {
    actions.updateToolState(toolCallId, {
      argsTotalBytes: streamMeta.totalBytes,
      activeArgKey: streamMeta.activeArgKey,
      activeArgChars: streamMeta.activeArgChars,
      activeArgPreviewHead: streamMeta.previewHead,
      activeArgPreviewTail: streamMeta.previewTail,
    })
  }

  // Accumulate JSON delta (capped) for best-effort partial parsing.
  // For huge args (e.g., doc_create.content), we intentionally stop parsing to avoid UI jank.
  const { json: newBuffer, truncated } = tracker.appendToolJson(toolCallId, data.delta, {
    maxChars: MAX_TOOL_JSON_BUFFER_CHARS,
  })
  if (truncated) {
    actions.updateToolState(toolCallId, { argsJsonTruncated: true })
  }

  // Parse partial JSON for progressive display only while:
  // - the buffer remains small, and
  // - we are not currently inside a large string value (activeArgKey)
  //
  // For long string payloads, UI should rely on the lightweight metadata instead.
  if (truncated || newBuffer.length > MAX_TOOL_ARGS_PARSE_CHARS || streamMeta?.activeArgKey) {
    return
  }

  // partial-json handles incomplete JSON fragments from LLM streaming
  const parsed = parsePartialJson(newBuffer, STR | OBJ | ARR | NUM)
  if (
    parsed &&
    typeof parsed === 'object' &&
    Object.keys(parsed as object).length > 0
  ) {
    // Get existing block content to preserve tool metadata
    const turn = useThreadStore.getState().turnById[ctx.turnId]
    const block = turn?.blocks.find((b) => b.sequence === blockIndex)

    // SOLID: Defensive - block may not exist yet in race conditions
    const existingContent = block?.content as Record<string, unknown> | undefined
    actions.setStreamingBlockContent(ctx.turnId, blockIndex, 'tool_use', {
      tool_name: existingContent?.tool_name ?? data.toolCallName ?? '',
      tool_use_id: existingContent?.tool_use_id ?? toolCallId,
      input: parsed as Record<string, unknown>,
    })

    // Update tool state with parsed input (keyed by toolCallId)
    actions.updateToolState(toolCallId, { input: parsed as Record<string, unknown> })
  }
}

/**
 * Handle TOOL_CALL_END event.
 * Finalizes tool arguments and transitions to READY state.
 */
export function handleToolCallEnd(
  data: ToolCallEndEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions
): void {
  const { tracker, logger } = ctx
  const toolCallId = normalizeToolCallId(data.toolCallId)

  const blockIndex = tracker.getToolCallBlockIndex(toolCallId)
  if (blockIndex === undefined) {
    logger.warn('sse:TOOL_CALL_END:no_block', { toolCallId })
    return
  }

  const wasTruncated = tracker.isToolJsonTruncated(toolCallId)

  // Final parse of accumulated JSON
  const finalBuffer = tracker.removeToolCall(toolCallId)
  if (finalBuffer && !wasTruncated) {
    try {
      const parsed = JSON.parse(finalBuffer) as Record<string, unknown>
      const turn = useThreadStore.getState().turnById[ctx.turnId]
      const block = turn?.blocks.find((b) => b.sequence === blockIndex)

      // Defensive: preserve existing content or use defaults
      const existingContent = block?.content as Record<string, unknown> | undefined
      actions.setStreamingBlockContent(ctx.turnId, blockIndex, 'tool_use', {
        tool_name: existingContent?.tool_name ?? '',
        tool_use_id: existingContent?.tool_use_id ?? toolCallId,
        input: parsed,
      })

      // Update tool state: args complete, ready for execution (keyed by toolCallId)
      actions.updateToolState(toolCallId, {
        state: ToolStreamState.EXECUTING,
        input: parsed,
        activeArgKey: null,
      })
    } catch (parseError) {
      logger.error('sse:TOOL_CALL_END:final_parse_error', parseError, {
        toolCallId,
        buffer: finalBuffer,
      })
      actions.updateToolState(toolCallId, {
        state: ToolStreamState.EXECUTING,
        activeArgKey: null,
      })
    }
  } else {
    // Truncated or empty buffer: still advance the state machine so the tool can execute.
    actions.updateToolState(toolCallId, {
      state: ToolStreamState.EXECUTING,
      activeArgKey: null,
    })
  }

  // Reset current block tracking (tool block is complete)
  tracker.setCurrentBlockType(null)

  logger.debug('sse:TOOL_CALL_END', {
    toolCallId,
    blockIndex,
  })
}

/**
 * Handle TOOL_CALL_RESULT event.
 * Inserts a tool_result block into the streaming turn and marks tool state complete/error.
 */
export function handleToolCallResult(
  data: ToolCallResultEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions
): void {
  const { tracker, logger } = ctx
  const toolCallId = normalizeToolCallId(data.toolCallId)

  // Backend emits `content` as a JSON string; parse for block content.
  let content: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(data.content) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') {
      content = parsed
    }
  } catch {
    content = { raw: data.content }
  }

  const isError = typeof content.is_error === 'boolean' ? content.is_error : false

  // Allocate a new block index for the tool_result.
  // Note: Results may arrive after subsequent blocks; pairing is by tool_use_id.
  const blockIndex = tracker.nextBlockIndex()
  actions.setStreamingBlockContent(ctx.turnId, blockIndex, 'tool_result', content)

  actions.updateToolState(toolCallId, {
    state: isError ? ToolStreamState.ERROR : ToolStreamState.COMPLETE,
  })

  logger.debug('sse:TOOL_CALL_RESULT', {
    toolCallId,
    blockIndex,
    isError,
  })
}
