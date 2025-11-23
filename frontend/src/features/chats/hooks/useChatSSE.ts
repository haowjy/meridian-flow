"use client"

import { useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@/core/stores/useChatStore'
import { useStreamingBuffer } from './useStreamingBuffer'
import type { BlockType } from '@/features/chats/types'
import { API_BASE_URL } from '@/core/lib/api'
import { makeLogger } from '@/core/lib/logger'

type DeltaType = 'text_delta' | 'thinking_delta' | 'signature_delta' | 'json_delta'

interface BlockStartEvent {
  block_index: number
  block_type?: BlockType
}

interface BlockDeltaEvent {
  block_index: number
  delta_type: DeltaType
  text_delta?: string
  json_delta?: string
}

interface TurnCompleteEvent {
  turn_id: string
  stop_reason?: string
}

interface TurnErrorEvent {
  turn_id: string
  error: string
}

/**
 * Hook that connects to the backend SSE stream for the currently streaming
 * assistant turn (if any) and applies text/thinking deltas to the chat store.
 *
 * Responsibility:
 * - Manage EventSource lifecycle for the active streaming turn
 * - Buffer high-frequency deltas via useStreamingBuffer
 * - Update Turn.blocks via useChatStore.appendStreamingTextDelta
 */
export function useChatSSE() {
  const {
    streamingTurnId,
    streamingUrl,
    appendStreamingTextDelta,
    setStreamingBlockContent,
    clearStreamingStream,
  } = useChatStore(
    useShallow((s) => ({
      streamingTurnId: s.streamingTurnId,
      streamingUrl: s.streamingUrl,
      appendStreamingTextDelta: s.appendStreamingTextDelta,
      setStreamingBlockContent: s.setStreamingBlockContent,
      clearStreamingStream: s.clearStreamingStream,
    }))
  )

  const logger = useMemo(() => makeLogger('useChatSSE'), [])

  const currentTurnIdRef = useRef<string | null>(null)
  const currentBlockIndexRef = useRef<number | null>(null)
  const currentBlockTypeRef = useRef<BlockType | null>(null)
  const jsonBufferRef = useRef<string>('')

  const { append, flush } = useStreamingBuffer({
    flushInterval: 50,
    onFlush: (content) => {
      const turnId = currentTurnIdRef.current
      const blockIndex = currentBlockIndexRef.current
      const blockType = currentBlockTypeRef.current ?? 'text'
      if (!turnId || blockIndex == null || !content) return
      appendStreamingTextDelta(turnId, blockIndex, blockType, content)
    },
  })

  useEffect(() => {
    if (!streamingTurnId || !streamingUrl) {
      return
    }

    const fullUrl =
      streamingUrl.startsWith('http://') || streamingUrl.startsWith('https://')
        ? streamingUrl
        : `${API_BASE_URL}${streamingUrl}`

    logger.debug('sse:connect', { fullUrl, streamingTurnId })

    currentTurnIdRef.current = streamingTurnId
    currentBlockIndexRef.current = null
    currentBlockTypeRef.current = null
    jsonBufferRef.current = ''

    const es = new EventSource(fullUrl)

    const handleBlockStart = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as BlockStartEvent
        currentBlockIndexRef.current = data.block_index
        currentBlockTypeRef.current = data.block_type ?? 'text'
      } catch (error) {
        logger.error('sse:block_start:parse_error', error)
      }
    }

        const handleBlockDelta = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as BlockDeltaEvent

        if (
          data.delta_type === 'text_delta' ||
          data.delta_type === 'thinking_delta'
        ) {
          if (data.text_delta) {
            append(data.text_delta)
          }
        }
        if (data.delta_type === 'json_delta' && data.json_delta) {
          jsonBufferRef.current += data.json_delta
        }
      } catch (error) {
        logger.error('sse:block_delta:parse_error', error)
      }
    }

    const handleBlockStop = () => {
      const turnId = currentTurnIdRef.current
      const blockIndex = currentBlockIndexRef.current
      const blockType = currentBlockTypeRef.current ?? 'text'

      // Flush any remaining text buffer
      flush()

      // If we collected JSON input for tool blocks, parse once and set content
      if (turnId && blockIndex != null && jsonBufferRef.current) {
        try {
          const parsed = JSON.parse(jsonBufferRef.current) as Record<string, unknown>
          setStreamingBlockContent(turnId, blockIndex, blockType, parsed)
        } catch (error) {
          logger.error('sse:block_stop:json_parse_error', error)
        } finally {
          jsonBufferRef.current = ''
        }
      }

      currentBlockIndexRef.current = null
      currentBlockTypeRef.current = null
    }

    const handleTurnComplete = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as TurnCompleteEvent
        logger.debug('sse:turn_complete', data)
      } catch {
        // Ignore parse errors here; completion is best-effort
      } finally {
        flush()
        clearStreamingStream()
        jsonBufferRef.current = ''
      }
    }

    const handleTurnError = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as TurnErrorEvent
        logger.error('sse:turn_error', data)
      } catch (error) {
        logger.error('sse:turn_error:parse_error', error)
      } finally {
        flush()
        clearStreamingStream()
        jsonBufferRef.current = ''
      }
    }

    es.addEventListener('block_start', handleBlockStart as EventListener)
    es.addEventListener('block_delta', handleBlockDelta as EventListener)
    es.addEventListener('block_stop', handleBlockStop as EventListener)
    es.addEventListener('turn_complete', handleTurnComplete as EventListener)
    es.addEventListener('turn_error', handleTurnError as EventListener)

    es.onerror = (error) => {
      logger.error('sse:error', error)
    }

    return () => {
      logger.debug('sse:cleanup')
      flush()
      es.close()
      currentTurnIdRef.current = null
      currentBlockIndexRef.current = null
      currentBlockTypeRef.current = null
      jsonBufferRef.current = ''
    }
  }, [
    streamingTurnId,
    streamingUrl,
    append,
    flush,
    appendStreamingTextDelta,
    setStreamingBlockContent,
    clearStreamingStream,
    logger,
  ])
}
