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
 *
 * Streaming state is sourced from useStreamStore (per-thread scoping).
 * Thread data mutations still go through useThreadStore.
 */

import { useEffect, useMemo, useRef, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  fetchEventSource,
  EventSourceMessage,
} from "@microsoft/fetch-event-source";
import { useThreadStore } from "@/core/stores/useThreadStore";
import {
  useStreamStore,
  useCurrentThreadStream,
} from "@/core/stores/useStreamStore";
import { useToolStreamStore } from "@/features/threads/stores/useToolStreamStore";
import { useStreamingBuffer } from "../useStreamingBuffer";
import { BlockTracker } from "../blockTracker";
import { dispatchSSEEvent } from "./SSEEventDispatcher";
import type { SSEDispatchContext, SSEStoreActions } from "./types";
import { API_BASE_URL, api } from "@/core/lib/api";
import { makeLogger } from "@/core/lib/logger";

/**
 * Hook that connects to the backend SSE stream for the currently streaming
 * assistant turn (if any) and applies text/thinking deltas to the thread store.
 */
export function useThreadSSE() {
  // Streaming state from stream store (per-thread scoped)
  const { streamingTurnId, streamingUrl } = useCurrentThreadStream();

  // Thread store for data mutations and coordination
  const {
    threadId,
    appendStreamingTextDelta,
    setStreamingBlockContent,
    refreshTurn,
    notifyStreamEnded,
    setInterjectionContent,
    applyStreamSwitch,
  } = useThreadStore(
    useShallow((s) => ({
      threadId: s.threadId,
      appendStreamingTextDelta: s.appendStreamingTextDelta,
      setStreamingBlockContent: s.setStreamingBlockContent,
      refreshTurn: s.refreshTurn,
      notifyStreamEnded: s.notifyStreamEnded,
      setInterjectionContent: s.setInterjectionContent,
      applyStreamSwitch: s.applyStreamSwitch,
    })),
  );

  // Stream store actions (stable via getState in actions object)
  const { removeStream, setBlockInfo } = useStreamStore(
    useShallow((s) => ({
      removeStream: s.removeStream,
      setBlockInfo: s.setBlockInfo,
    })),
  );

  const logger = useMemo(() => makeLogger("useThreadSSE"), []);

  const currentTurnIdRef = useRef<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  // BlockTracker consolidates all ID->blockIndex tracking into one class
  const trackerRef = useRef(new BlockTracker());

  // Handle text buffer flush
  const handleFlush = useCallback(
    (blockIndex: number, blockType: string, content: string) => {
      const turnId = currentTurnIdRef.current;
      // Empty string "" is valid content (convention: treat empty as valid); keep !turnId — IDs are never empty string
      if (!turnId || blockIndex == null || content == null) return;
      appendStreamingTextDelta(turnId, blockIndex, blockType, content);
    },
    [appendStreamingTextDelta],
  );

  const { append, flush } = useStreamingBuffer({
    flushInterval: 50,
    onFlush: handleFlush,
  });

  // Construct clearStreamingStream and setStreamingBlockInfo for SSEStoreActions
  // These compose stream store + thread store actions to match the existing interface
  const clearStreamingStream = useCallback(() => {
    const turnId = currentTurnIdRef.current;
    if (turnId) {
      removeStream(turnId);
    }
    useThreadStore.getState().setInterjectionContent(null);
  }, [removeStream]);

  const setStreamingBlockInfo = useCallback(
    (
      blockIndex: number | null,
      blockType: Parameters<typeof setBlockInfo>[2],
    ) => {
      const turnId = currentTurnIdRef.current;
      if (turnId) {
        setBlockInfo(turnId, blockIndex, blockType);
      }
    },
    [setBlockInfo],
  );

  useEffect(() => {
    if (!streamingTurnId || !streamingUrl) {
      return;
    }

    const fullUrl =
      streamingUrl.startsWith("http://") || streamingUrl.startsWith("https://")
        ? streamingUrl
        : `${API_BASE_URL}${streamingUrl}`;

    currentTurnIdRef.current = streamingTurnId;

    // Reset tracker for new stream
    trackerRef.current.clear();

    // Capture tracker reference for cleanup
    const tracker = trackerRef.current;

    // Create abort controller for this stream
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    // Build dispatch context (stable for this stream)
    const buildContext = (): SSEDispatchContext => ({
      turnId: currentTurnIdRef.current!,
      threadId,
      tracker,
      buffer: { append, flush },
      logger,
      ctrl,
    });

    // Build store actions (stable references via getState)
    const actions: SSEStoreActions = {
      appendStreamingTextDelta,
      setStreamingBlockContent,
      clearStreamingStream,
      refreshTurn,
      setStreamingBlockInfo,
      notifyStreamEnded,
      setInterjectionContent,
      applyStreamSwitch,
      updateToolState: useToolStreamStore.getState().updateToolState,
      clearToolStates: useToolStreamStore.getState().clearAll,
    };

    // New stream: clear previous tool streaming UI state.
    // We avoid clearing on stream end so tool/thinking blocks don't collapse when refreshTurn swaps blocks.
    actions.clearToolStates();

    const connect = async () => {
      try {
        // Get session token
        const { createClient } = await import("@/core/supabase/client");
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;

        if (!token) {
          logger.error("sse:error:no_token", "No auth token available");
          clearStreamingStream();
          return;
        }

        await fetchEventSource(fullUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: ctrl.signal,
          openWhenHidden: true, // Keep streaming in background tabs

          async onopen(response: Response) {
            if (response.ok) {
              // Fetch live interjection state on connect/reconnect.
              // This avoids stale state from buffered SSE events being replayed.
              const turnId = currentTurnIdRef.current;
              if (turnId) {
                api.turns
                  .getInterjection(turnId, { signal: ctrl.signal })
                  .then((res) => {
                    if (res.content) {
                      setInterjectionContent(res.content);
                    } else {
                      // Clear any stale interjection content
                      setInterjectionContent(null);
                    }
                  })
                  .catch(() => {
                    // Ignore - interjection fetch is best-effort
                  });
              }
              return;
            }

            // AG-UI: Rate limiting should be handled with backoff (429)
            if (response.status === 429) {
              logger.warn("sse:error:rate_limited", {
                status: response.status,
                retryAfter: response.headers.get("Retry-After"),
              });
              // fetch-event-source will retry automatically, but we log for visibility
              throw new Error(`Rate limited: ${response.status}`);
            }

            // Client errors (4xx except 429) - don't retry
            if (response.status >= 400 && response.status < 500) {
              logger.error("sse:error:client", { status: response.status });
              throw new Error(`Client error: ${response.status}`);
            }

            // Server errors (5xx) - retry with backoff
            logger.error("sse:error:server", { status: response.status });
            throw new Error(`Server error: ${response.status}`);
          },

          onmessage(msg: EventSourceMessage) {
            // Dispatch event to appropriate handler
            dispatchSSEEvent(msg.event, msg.data, buildContext(), actions);
          },

          onclose() {
            // Server closed the stream without an explicit terminal event
            if (ctrl.signal.aborted) {
              return;
            }

            // Notify waiters that stream has ended
            const currentTurnId = currentTurnIdRef.current;
            if (currentTurnId) {
              notifyStreamEnded(currentTurnId);
            }

            flush();
            clearStreamingStream();
            trackerRef.current.clear();
            setStreamingBlockInfo(null, null);

            if (threadId && currentTurnId) {
              refreshTurn(threadId, currentTurnId).catch((err) =>
                logger.error("sse:closed:refresh_error", err),
              );
            }
          },

          onerror(err: unknown) {
            if (ctrl.signal.aborted) {
              return;
            }

            logger.error("sse:error", err);
            flush();
            clearStreamingStream();
            setStreamingBlockInfo(null, null);
            throw err;
          },
        });
      } catch (err) {
        if (!ctrl.signal.aborted) {
          logger.error("sse:connect_error", err);
          clearStreamingStream();
          setStreamingBlockInfo(null, null);
        }
      }
    };

    connect();

    return () => {
      flush();
      ctrl.abort();
      ctrlRef.current = null;
      currentTurnIdRef.current = null;
      tracker.clear();
      setStreamingBlockInfo(null, null);
    };
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
    setInterjectionContent,
    applyStreamSwitch,
  ]);
}
