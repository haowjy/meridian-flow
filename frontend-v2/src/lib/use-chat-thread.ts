// ═══════════════════════════════════════════════════════════════════
// useChatThread — per-surface chat thread hook.
//
// Each chat surface (Converse thread, Agents detail, Studio sidecar)
// gets its own thread store instance, created via createThreadStore().
// The store auto-subscribes to streams when a StreamingChannelClient
// is available from the ThreadWsProvider context.
//
// Usage:
//   const chat = useChatThread(projectId, threadId)
//   <ChatComposer onSubmit={chat.send} isStreaming={chat.isStreaming} ... />
//   <TurnList turns={chat.turns} ... />
// ═══════════════════════════════════════════════════════════════════

import * as React from "react"
import { useStore } from "zustand"

import { useThreadWsContextSafe } from "@/features/threads/streaming/ThreadWsProvider"

import { isLiveProjectId } from "@/layouts/shared/data-mappers"

import { createThreadStore, type ThreadStoreApi } from "./thread-store"

/**
 * Hook providing a complete chat thread interface for a single thread.
 *
 * Creates its own Zustand store instance — multiple useChatThread
 * hooks in different shells won't clobber each other's state.
 *
 * When mounted inside a ThreadWsProvider, the store auto-subscribes
 * to assistant turn streams on send/edit/regenerate.
 */
export function useChatThread(
  projectId: string | undefined,
  threadId: string | undefined,
) {
  const liveProject = isLiveProjectId(projectId)
  const isNewThread = threadId === "new"

  // Get streaming client from context (null outside ThreadWsProvider)
  const wsCtx = useThreadWsContextSafe()
  const streaming = wsCtx?.streaming ?? null

  // Create store instance — stable across renders, recreated when
  // streaming client identity changes (projectId change → new provider)
  const storeRef = React.useRef<ThreadStoreApi | null>(null)
  const streamingRef = React.useRef(streaming)

  if (!storeRef.current || streamingRef.current !== streaming) {
    storeRef.current = createThreadStore(streaming)
    streamingRef.current = streaming
  }

  const store = storeRef.current

  // Load thread turns when threadId changes
  React.useEffect(() => {
    if (!liveProject || !threadId || isNewThread) return

    const current = store.getState()
    if (current.threadId === threadId) return // Already loaded

    store.getState().loadThread(threadId)
  }, [store, liveProject, threadId, isNewThread])

  // Subscribe to store slices
  const turnIds = useStore(store, (s) => s.turnIds)
  const turnById = useStore(store, (s) => s.turnById)
  const isStreaming = useStore(store, (s) => s.isStreaming)
  const loadStatus = useStore(store, (s) => s.loadStatus)
  const storeError = useStore(store, (s) => s.error)

  // Derive turns array from normalized state
  const turns = React.useMemo(() => {
    if (!liveProject) return null // Will use mock data
    return turnIds
      .map((id) => turnById[id])
      .filter(Boolean)
  }, [liveProject, turnIds, turnById])

  // Actions — stable callbacks that delegate to the store
  const send = React.useCallback(
    async (text: string) => {
      if (!liveProject || !projectId) return

      try {
        await store.getState().sendMessage(text, {
          projectId,
          threadId: isNewThread ? undefined : threadId,
        })
      } catch {
        // Error is set in the store
      }
    },
    [store, liveProject, projectId, threadId, isNewThread],
  )

  const stop = React.useCallback(() => {
    void store.getState().interruptStream()
  }, [store])

  const interject = React.useCallback(
    (text: string) => {
      if (!liveProject) return
      void store.getState().submitInterjection(text)
    },
    [store, liveProject],
  )

  const switchSibling = React.useCallback(
    (targetTurnId: string) => {
      void store.getState().switchSibling(targetTurnId)
    },
    [store],
  )

  const editTurn = React.useCallback(
    (turnId: string, newText: string) => {
      void store.getState().editTurn(turnId, newText)
    },
    [store],
  )

  const regenerateTurn = React.useCallback(
    (turnId: string) => {
      void store.getState().regenerateTurn(turnId)
    },
    [store],
  )

  // Show toast on errors
  React.useEffect(() => {
    if (storeError) {
      // Import sonner lazily to avoid circular deps
      import("sonner").then(({ toast }) => {
        toast.error(storeError)
      })
      store.getState().clearError()
    }
  }, [store, storeError])

  return {
    /** Mapped turns for display (null in demo mode — use mock data) */
    turns,
    isStreaming: liveProject ? isStreaming : false,
    isLoading: loadStatus === "loading",
    error: storeError,
    isLive: liveProject,

    // Actions
    send,
    stop,
    interject,
    switchSibling,
    editTurn,
    regenerateTurn,

    // Raw store for advanced access (e.g., reading turnById directly)
    store,
  }
}
