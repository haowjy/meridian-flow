import { useEffect, useMemo, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useThreadStore, ToolStreamState } from '@/core/stores/useThreadStore'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { useStreamingBuffer } from './useStreamingBuffer'
import type { BlockType } from '@/features/threads/types'
import { API_BASE_URL } from '@/core/lib/api'
import { makeLogger } from '@/core/lib/logger'
import { fetchEventSource, EventSourceMessage } from '@microsoft/fetch-event-source'

type DeltaType = 'text_delta' | 'thinking_delta' | 'signature_delta' | 'json_delta'

interface BlockStartEvent {
  block_index: number
  block_type?: BlockType
  tool_name?: string    // Tool name for tool_use blocks
  tool_use_id?: string  // Unique ID for this tool invocation
}

// Progressive tool input updates during streaming
interface ToolInputUpdateEvent {
  block_index: number
  tool_use_id: string
  tool_name: string // Tool name (e.g., "doc_view") for display
  state: 'preparing' | 'ready' // Must match backend ToolStatePreparing/ToolStateReady
  input?: Record<string, unknown>
}

// Tool execution started event
interface ToolExecutingEvent {
  block_index: number
  tool_use_id: string
  tool_name: string
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
  is_cancelled?: boolean // User cancelled streaming (don't show error toast)
}

/**
 * Hook that connects to the backend SSE stream for the currently streaming
 * assistant turn (if any) and applies text/thinking deltas to the thread store.
 *
 * Responsibility:
 * - Manage EventSource lifecycle for the active streaming turn
 * - Buffer high-frequency deltas via useStreamingBuffer
 * - Update Turn.blocks via useThreadStore.appendStreamingTextDelta
 */
export function useThreadSSE() {
  const {
    threadId,
    streamingTurnId,
    streamingUrl,
    appendStreamingTextDelta,
    setStreamingBlockContent,
    clearStreamingStream,
    refreshTurn,
    setStreamingBlockInfo,
    updateToolState,
  } = useThreadStore(
    useShallow((s) => ({
      threadId: s.threadId,
      streamingTurnId: s.streamingTurnId,
      streamingUrl: s.streamingUrl,
      appendStreamingTextDelta: s.appendStreamingTextDelta,
      setStreamingBlockContent: s.setStreamingBlockContent,
      clearStreamingStream: s.clearStreamingStream,
      refreshTurn: s.refreshTurn,
      setStreamingBlockInfo: s.setStreamingBlockInfo,
      updateToolState: s.updateToolState,
    }))
  )

  const logger = useMemo(() => makeLogger('useThreadSSE'), [])

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

                  // Initialize tool state if tool metadata present
                  if (data.tool_name) {
                    updateToolState(data.block_index, {
                      state: ToolStreamState.PREPARING,
                      toolName: data.tool_name,
                      toolUseId: data.tool_use_id,
                    })

                    // Create skeleton block IMMEDIATELY for tool_use so existing rendering pipeline works
                    // This populates block.content.tool_name and block.content.tool_use_id
                    // Without this, the block isn't added to turn.blocks until block_stop (too late!)
                    const turnId = currentTurnIdRef.current
                    if (turnId && blockType === 'tool_use') {
                      setStreamingBlockContent(turnId, data.block_index, blockType, {
                        tool_name: data.tool_name,
                        tool_use_id: data.tool_use_id,
                        input: {},  // Will be updated progressively via tool_input_update
                      })
                    }
                  }
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

              // Progressive tool input updates during streaming
              case 'tool_input_update': {
                try {
                  const data = JSON.parse(msg.data) as ToolInputUpdateEvent
                  updateToolState(data.block_index, {
                    state: data.state === 'ready' ? ToolStreamState.READY : ToolStreamState.PREPARING,
                    toolName: data.tool_name, // Always update toolName for display
                    input: data.input,
                  })

                  // Also update the block content so existing rendering pipeline sees the input
                  // This allows custom tool blocks (DocViewBlock, etc.) to display input progressively
                  const turnId = currentTurnIdRef.current
                  if (turnId && data.input) {
                    setStreamingBlockContent(turnId, data.block_index, 'tool_use', {
                      tool_name: data.tool_name,
                      tool_use_id: data.tool_use_id,
                      input: data.input,
                    })
                  }
                } catch (error) {
                  logger.error('sse:tool_input_update:parse_error', error)
                }
                break
              }

              // Tool execution started
              case 'tool_executing': {
                try {
                  const data = JSON.parse(msg.data) as ToolExecutingEvent
                  updateToolState(data.block_index, { state: ToolStreamState.EXECUTING })
                } catch (error) {
                  logger.error('sse:tool_executing:parse_error', error)
                }
                break
              }

              case 'turn_complete': {
                try {
                  const data = JSON.parse(msg.data) as TurnCompleteEvent
                  logger.debug('sse:turn_complete', data)

                  // Refresh the turn to ensure we have the final state (including any missing blocks or metadata)
                  if (threadId && data.turn_id) {
                    refreshTurn(threadId, data.turn_id).catch(err =>
                      logger.error('sse:turn_complete:refresh_error', err)
                    )
                  }

                  // Refresh active document in case AI edited it via doc_edit tool
                  // This ensures ai_version changes are reflected in the editor
                  const activeDocId = useEditorStore.getState()._activeDocumentId
                  if (activeDocId) {
                    useEditorStore.getState().refreshDocument(activeDocId).catch(err =>
                      logger.error('sse:turn_complete:document_refresh_error', err)
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

                  // Log error (non-cancellation) or debug (cancellation)
                  if (!data.is_cancelled) {
                    logger.error('sse:turn_error', data)
                  } else {
                    logger.debug('sse:turn_cancelled', data)
                  }

                  // Refresh the turn to ensure we have the final state (partial blocks + error field)
                  // The inline error will be displayed via Turn.error in AssistantTurn component
                  if (threadId && data.turn_id) {
                    refreshTurn(threadId, data.turn_id).catch(err =>
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

          onclose() {
            // Server closed the stream without an explicit terminal event.
            // Treat this as a best-effort end-of-stream and reconcile state via refresh.
            if (ctrl.signal.aborted) {
              return
            }

            logger.debug('sse:closed')
            flush()
            clearStreamingStream()
            jsonBufferRef.current = ''
            setStreamingBlockInfo(null, null)

            const currentTurnId = currentTurnIdRef.current
            if (threadId && currentTurnId) {
              refreshTurn(threadId, currentTurnId).catch(err =>
                logger.error('sse:closed:refresh_error', err)
              )
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
    threadId,
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
    updateToolState,
  ])
}
