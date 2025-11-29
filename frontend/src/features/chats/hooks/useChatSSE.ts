import { useEffect, useMemo, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useChatStore } from '@/core/stores/useChatStore'
import { useStreamingBuffer } from './useStreamingBuffer'
import type { BlockType } from '@/features/chats/types'
import { API_BASE_URL } from '@/core/lib/api'
import { makeLogger } from '@/core/lib/logger'
import { fetchEventSource, EventSourceMessage } from '@microsoft/fetch-event-source'

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
    chatId,
    streamingTurnId,
    streamingUrl,
    appendStreamingTextDelta,
    setStreamingBlockContent,
    clearStreamingStream,
    refreshTurn,
    setStreamingBlockInfo,
  } = useChatStore(
    useShallow((s) => ({
      chatId: s.chatId,
      streamingTurnId: s.streamingTurnId,
      streamingUrl: s.streamingUrl,
      appendStreamingTextDelta: s.appendStreamingTextDelta,
      setStreamingBlockContent: s.setStreamingBlockContent,
      clearStreamingStream: s.clearStreamingStream,
      refreshTurn: s.refreshTurn,
      setStreamingBlockInfo: s.setStreamingBlockInfo,
    }))
  )

  const logger = useMemo(() => makeLogger('useChatSSE'), [])

  const currentTurnIdRef = useRef<string | null>(null)
  const currentBlockIndexRef = useRef<number | null>(null)
  const currentBlockTypeRef = useRef<BlockType | null>(null)
  const jsonBufferRef = useRef<string>('')
  const ctrlRef = useRef<AbortController | null>(null)

  const handleFlush = useCallback((content: string) => {
    const turnId = currentTurnIdRef.current
    const blockIndex = currentBlockIndexRef.current
    const blockType = currentBlockTypeRef.current ?? 'text'
    if (!turnId || blockIndex == null || !content) return
    appendStreamingTextDelta(turnId, blockIndex, blockType, content)
  }, [appendStreamingTextDelta])

  const { append, flush } = useStreamingBuffer({
    flushInterval: 50,
    onFlush: handleFlush,
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

    // Create abort controller for this stream
    const ctrl = new AbortController()
    ctrlRef.current = ctrl

    const connect = async () => {
      try {
        // Get session token
        const { createClient } = await import('@/core/supabase/client')
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.access_token

        if (!token) {
          logger.error('sse:error:no_token', 'No auth token available')
          clearStreamingStream()
          return
        }

        await fetchEventSource(fullUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: ctrl.signal,
          openWhenHidden: true, // Keep streaming in background tabs
          
          async onopen(response: Response) {
            if (response.ok) {
              logger.debug('sse:connected')
              return
            }
            
            // Handle errors
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
              // Client errors (4xx) are fatal - don't retry
              logger.error('sse:error:client', { status: response.status })
              throw new Error(`Client error: ${response.status}`)
            }
            
            // Server errors (5xx) might be retried by the library
            logger.error('sse:error:server', { status: response.status })
            throw new Error(`Server error: ${response.status}`)
          },

          onmessage(msg: EventSourceMessage) {
            // Handle different event types
            switch (msg.event) {
              case 'block_start': {
                try {
                  const data = JSON.parse(msg.data) as BlockStartEvent
                  const blockType = data.block_type ?? 'text'

                  currentBlockIndexRef.current = data.block_index
                  currentBlockTypeRef.current = blockType
                  setStreamingBlockInfo(data.block_index, blockType)
                  // Clear JSON buffer for new block to prevent concatenation errors
                  jsonBufferRef.current = ''
                } catch (error) {
                  logger.error('sse:block_start:parse_error', error)
                }
                break
              }

              case 'block_delta': {
                try {
                  const data = JSON.parse(msg.data) as BlockDeltaEvent

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
                break
              }

              case 'block_stop': {
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
                      logger.error('sse:block_stop:json_parse_error', error, {
                        buffer: jsonBufferRef.current,
                        bufferLength: jsonBufferRef.current.length
                      })
                    } finally {
                    jsonBufferRef.current = ''
                  }
                }

                currentBlockIndexRef.current = null
                currentBlockTypeRef.current = null
                setStreamingBlockInfo(null, null)
                break
              }

              case 'turn_complete': {
                try {
                  const data = JSON.parse(msg.data) as TurnCompleteEvent
                  logger.debug('sse:turn_complete', data)

                  if (data.stop_reason === 'max_tool_rounds') {
                    toast.warning('Tool iteration limit reached', {
                      description: 'The assistant used the maximum number of tool iterations (5). The conversation has been completed.',
                      duration: 5000,
                    })
                  }
                  
                  // Refresh the turn to ensure we have the final state (including any missing blocks or metadata)
                  if (chatId && data.turn_id) {
                    refreshTurn(chatId, data.turn_id).catch(err => 
                      logger.error('sse:turn_complete:refresh_error', err)
                    )
                  }
                } catch {
                  // Ignore parse errors
                } finally {
                  flush()
                  clearStreamingStream()
                  jsonBufferRef.current = ''
                  setStreamingBlockInfo(null, null)
                  // Stop the stream
                  ctrl.abort()
                }
                break
              }

              case 'turn_error': {
                logger.debug('sse:turn_error:raw', { data: msg.data })
                try {
                  const data = JSON.parse(msg.data) as TurnErrorEvent
                  logger.error('sse:turn_error', data)
                  
                  // Show error toast
                  toast.error('Streaming Error', {
                    description: data.error || 'An error occurred while generating the response.',
                    duration: 5000,
                  })

                  // Refresh the turn to ensure we have the final state (partial blocks)
                  if (chatId && data.turn_id) {
                    refreshTurn(chatId, data.turn_id).catch(err => 
                      logger.error('sse:turn_error:refresh_error', err)
                    )
                  }
                } catch (error) {
                  logger.error('sse:turn_error:parse_error', error)
                } finally {
                  flush()
                  clearStreamingStream()
                  jsonBufferRef.current = ''
                  setStreamingBlockInfo(null, null)
                  // Stop the stream
                  ctrl.abort()
                }
                break
              }
            }
          },

          onerror(err: unknown) {
            // If aborted, ignore
            if (ctrl.signal.aborted) {
              return
            }
            
            logger.error('sse:error', err)
            // Rethrow to let the library handle retry logic if configured,
            // or stop if it's a fatal error.
            // For now, we'll stop on error to match previous behavior
            flush()
            clearStreamingStream()
            setStreamingBlockInfo(null, null)
            throw err // This stops retries in fetchEventSource by default if not handled
          }
        })
      } catch (err) {
        if (!ctrl.signal.aborted) {
          logger.error('sse:connect_error', err)
          clearStreamingStream()
          setStreamingBlockInfo(null, null)
        }
      }
    }

    connect()

    return () => {
      logger.debug('sse:cleanup')
      flush()
      ctrl.abort()
      ctrlRef.current = null
      currentTurnIdRef.current = null
      currentBlockIndexRef.current = null
      currentBlockTypeRef.current = null
      jsonBufferRef.current = ''
      setStreamingBlockInfo(null, null)
    }
  }, [
    chatId,
    streamingTurnId,
    streamingUrl,
    append,
    flush,
    appendStreamingTextDelta,
    setStreamingBlockContent,
    clearStreamingStream,
    refreshTurn,
    logger,
    setStreamingBlockInfo,
  ])
}
