/**
 * useSSEConnection - SSE Connection Lifecycle Hook
 *
 * Manages the SSE connection lifecycle for streaming assistant turns.
 * Delegates event handling to the SSEEventDispatcher.
 *
 * Responsibilities:
 * - Establish and maintain SSE connection
 * - Handle connection lifecycle (connect, disconnect, error, close)
 * - Buffer high-frequency text deltas
 * - Delegate event processing to handlers
 */

import { useEffect, useMemo, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { fetchEventSource, EventSourceMessage } from '@microsoft/fetch-event-source'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useToolStreamStore } from '@/features/threads/stores/useToolStreamStore'
import { useStreamingBuffer } from '../useStreamingBuffer'
import { BlockTracker } from '../blockTracker'
import { dispatchSSEEvent } from './SSEEventDispatcher'
import type { SSEDispatchContext, SSEStoreActions } from './types'
import { API_BASE_URL } from '@/core/lib/api'
import { makeLogger } from '@/core/lib/logger'

/**
 * Hook that connects to the backend SSE stream for the currently streaming
 * assistant turn (if any) and applies text/thinking deltas to the thread store.
 */
export function useThreadSSE() {
  // Subscribe to thread store for connection state
  const {
    threadId,
    streamingTurnId,
    streamingUrl,
    appendStreamingTextDelta,
    setStreamingBlockContent,
    clearStreamingStream,
    refreshTurn,
    setStreamingBlockInfo,
    notifyStreamEnded,
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
      notifyStreamEnded: s.notifyStreamEnded,
    }))
  )

  const logger = useMemo(() => makeLogger('useThreadSSE'), [])

  const currentTurnIdRef = useRef<string | null>(null)
  const ctrlRef = useRef<AbortController | null>(null)

  // BlockTracker consolidates all ID->blockIndex tracking into one class
  const trackerRef = useRef(new BlockTracker())

  // Handle text buffer flush
  const handleFlush = useCallback(
    (blockIndex: number, blockType: string, content: string) => {
      const turnId = currentTurnIdRef.current
      if (!turnId || blockIndex == null || !content) return
      appendStreamingTextDelta(turnId, blockIndex, blockType, content)
    },
    [appendStreamingTextDelta]
  )

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

    // Reset tracker for new stream
    trackerRef.current.clear()

    // Capture tracker reference for cleanup
    const tracker = trackerRef.current

    // Create abort controller for this stream
    const ctrl = new AbortController()
    ctrlRef.current = ctrl

    // Build dispatch context (stable for this stream)
    const buildContext = (): SSEDispatchContext => ({
      turnId: currentTurnIdRef.current!,
      threadId,
      tracker,
      buffer: { append, flush },
      logger,
      ctrl,
    })

    // Build store actions (stable references via getState)
    const actions: SSEStoreActions = {
      appendStreamingTextDelta,
      setStreamingBlockContent,
      clearStreamingStream,
      refreshTurn,
      setStreamingBlockInfo,
      notifyStreamEnded,
      updateToolState: useToolStreamStore.getState().updateToolState,
      clearToolStates: useToolStreamStore.getState().clearAll,
    }

    const connect = async () => {
      try {
        // Get session token
        const { createClient } = await import('@/core/supabase/client')
        const supabase = createClient()
        const {
          data: { session },
        } = await supabase.auth.getSession()
        const token = session?.access_token

        if (!token) {
          logger.error('sse:error:no_token', 'No auth token available')
          clearStreamingStream()
          actions.clearToolStates()
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

            // AG-UI: Rate limiting should be handled with backoff (429)
            if (response.status === 429) {
              logger.warn('sse:error:rate_limited', {
                status: response.status,
                retryAfter: response.headers.get('Retry-After'),
              })
              // fetch-event-source will retry automatically, but we log for visibility
              throw new Error(`Rate limited: ${response.status}`)
            }

            // Client errors (4xx except 429) - don't retry
            if (response.status >= 400 && response.status < 500) {
              logger.error('sse:error:client', { status: response.status })
              throw new Error(`Client error: ${response.status}`)
            }

            // Server errors (5xx) - retry with backoff
            logger.error('sse:error:server', { status: response.status })
            throw new Error(`Server error: ${response.status}`)
          },

          onmessage(msg: EventSourceMessage) {
            // Dispatch event to appropriate handler
            dispatchSSEEvent(msg.event, msg.data, buildContext(), actions)
          },

          onclose() {
            // Server closed the stream without an explicit terminal event
            if (ctrl.signal.aborted) {
              return
            }

            logger.debug('sse:closed')

            // Notify waiters that stream has ended
            const currentTurnId = currentTurnIdRef.current
            if (currentTurnId) {
              notifyStreamEnded(currentTurnId)
            }

            flush()
            clearStreamingStream()
            actions.clearToolStates()
            trackerRef.current.clear()
            setStreamingBlockInfo(null, null)

            if (threadId && currentTurnId) {
              refreshTurn(threadId, currentTurnId).catch((err) =>
                logger.error('sse:closed:refresh_error', err)
              )
            }
          },

          onerror(err: unknown) {
            if (ctrl.signal.aborted) {
              return
            }

            logger.error('sse:error', err)
            flush()
            clearStreamingStream()
            actions.clearToolStates()
            setStreamingBlockInfo(null, null)
            throw err
          },
        })
      } catch (err) {
        if (!ctrl.signal.aborted) {
          logger.error('sse:connect_error', err)
          clearStreamingStream()
          actions.clearToolStates()
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
      tracker.clear()
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
    notifyStreamEnded,
  ])
}
