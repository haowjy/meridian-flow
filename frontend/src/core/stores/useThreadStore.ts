import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  Thread,
  Turn,
  type BlockType,
  type ThreadRequestOptions,
} from '@/features/threads/types'
import { DEFAULT_THREAD_REQUEST_OPTIONS, requestParamsToOptions } from '@/features/threads/types'
import { api } from '@/core/lib/api'
import { getErrorMessageWithFallback } from '@/core/lib/errors'
import { makeLogger } from '@/core/lib/logger'

/**
 * TODO(DEXIE CACHING) - High Priority Follow-up:
 * Implement windowed Dexie caching for thread turns (last ~100 items) and re-enable
 * cache policies for fast warm loads and offline fallback. Current MVP intentionally
 * bypasses Dexie for turns to simplify server-driven pagination integration.
 * - Cache shape: messages table keyed by threadId with createdAt index
 * - Strategy: windowed write-through on paginate/send; hydrate on openThread
 * - Ensure no duplication and preserve chronological order on merges
 */
type LoadStatus = 'idle' | 'loading' | 'success' | 'error'

interface ThreadStore {
  threads: Thread[]
  turns: Turn[]
  threadId: string | null
  currentTurnId: string | null
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  statusThreads: LoadStatus
  isFetchingThreads: boolean
  isLoadingTurns: boolean
  error: string | null
  navigationAbortController: AbortController | null

  // Computed getter for backwards compatibility
  isLoadingThreads: boolean

  // Streaming state for the currently active assistant turn (at most one)
  streamingTurnId: string | null
  streamingUrl: string | null
  streamingBlockIndex: number | null
  streamingBlockType: BlockType | null

  loadThreads: (projectId: string, signal?: AbortSignal) => Promise<void>
  // Legacy shape retained; internally calls openThread
  loadTurns: (threadId: string, signal?: AbortSignal) => Promise<void>
  createThread: (projectId: string, title: string) => Promise<Thread>
  renameThread: (threadId: string, title: string) => Promise<void>
  createTurn: (threadId: string, messageText: string, options: ThreadRequestOptions) => Promise<void>
  // Cold-start: creates a new thread atomically with the first turn
  startNewThread: (projectId: string, messageText: string, options: ThreadRequestOptions) => Promise<Thread>
  deleteThread: (threadId: string) => Promise<void>

  // Streaming helpers
  appendStreamingTextDelta: (
    turnId: string,
    blockIndex: number,
    blockType: string,
    delta: string
  ) => void
  setStreamingBlockContent: (
    turnId: string,
    blockIndex: number,
    blockType: string,
    content: Record<string, unknown>
  ) => void
  clearStreamingStream: () => void
  setStreamingBlockInfo: (
    blockIndex: number | null,
    blockType: BlockType | null
  ) => void
  setCurrentTurnId: (turnId: string) => void

  interruptStreamingTurn: () => Promise<void>

  // Pagination & navigation (server-driven)
  openThread: (threadId: string, initialTurnId?: string, signal?: AbortSignal) => Promise<void>
  paginateBefore: (signal?: AbortSignal) => Promise<void>
  paginateAfter: (signal?: AbortSignal) => Promise<void>
  switchSibling: (threadId: string, targetTurnId: string, signal?: AbortSignal) => Promise<void>
  editTurn: (threadId: string, parentTurnId: string | undefined, content: string, options?: ThreadRequestOptions) => Promise<void>
  regenerateTurn: (threadId: string, parentTurnId: string) => Promise<void>
  refreshTurn: (threadId: string, turnId: string) => Promise<void>
  clearError: () => void
}

/**
 * Helper to detect if any assistant turn is actively streaming.
 * Returns streaming state or null values if no streaming turn found.
 */
const detectStreamingState = (turns: Turn[]) => {
  // Find any assistant turn that's actively streaming
  const streamingTurn = turns.find(
    (t) =>
      (t.status === 'streaming' || t.status === 'waiting_subagents') && t.role === 'assistant'
  )

  return streamingTurn
    ? {
        streamingTurnId: streamingTurn.id,
        streamingUrl: `/api/turns/${streamingTurn.id}/stream`,
      }
    : {
        streamingTurnId: null,
        streamingUrl: null,
      }
}

/**
 * Helper to update last_viewed_turn_id bookmark.
 * Logs errors but doesn't throw - bookmark updates are non-critical.
 */
const updateLastViewedTurnBookmark = async (threadId: string, turnId: string) => {
  try {
    await api.threads.updateLastViewedTurn(threadId, turnId)
  } catch (err) {
    const log = makeLogger('thread-store')
    log.warn('Failed to update last_viewed_turn_id', { threadId, turnId, error: err })
  }
}

export const useThreadStore = create<ThreadStore>()(
  persist(
    (set, get) => ({
      threads: [],
      turns: [],
      threadId: null,
      currentTurnId: null,
      hasMoreBefore: false,
      hasMoreAfter: false,
      statusThreads: 'idle' as LoadStatus,
      isFetchingThreads: false,
      isLoadingTurns: false,
      error: null,
      navigationAbortController: null,
      streamingTurnId: null,
      streamingUrl: null,
       streamingBlockIndex: null,
       streamingBlockType: null,

      // Computed getter for backwards compatibility
      get isLoadingThreads() {
        return get().statusThreads === 'loading'
      },

      refreshTurn: async (threadId: string, turnId: string) => {
        set({ error: null })
        try {
          const { blocks, error: turnError, status } = await api.turns.getBlocks(turnId)
          set((state) => ({
            turns: state.turns.map((turn) =>
              turn.id !== turnId ? turn : {
                ...turn,
                blocks,
                error: turnError,
                status,
              }
            ),
          }))
        } catch (error) {
          set({ error: getErrorMessageWithFallback(error, 'Failed to refresh turn') })
        }
      },

      loadThreads: async (projectId: string, signal?: AbortSignal) => {
        // Set loading state based on whether we have cached thread data
        const currentState = get()
        const status = currentState.threads.length === 0 ? 'loading' : 'success'
        set({ statusThreads: status, isFetchingThreads: true, error: null })

        try {
          // Network-first for threads; keep Dexie for threads if needed in future
          const data = await api.threads.list(projectId, { signal })
          set({ threads: data, statusThreads: 'success', isFetchingThreads: false })
        } catch (error) {
          // Handle AbortError silently
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isFetchingThreads: false })
            return
          }

          const message = getErrorMessageWithFallback(error, 'Failed to load threads')
          // If we have cached threads, keep status as 'success', otherwise set to 'error'
          const currentThreads = get().threads
          const errorStatus = currentThreads.length > 0 ? 'success' : 'error'
          set({ error: message, statusThreads: errorStatus, isFetchingThreads: false })
        }
      },

      loadTurns: async (threadId: string, signal?: AbortSignal) => {
        // Fetch thread to get lastViewedTurnId for auto-scroll
        const thread = await api.threads.get(threadId)
        // Delegate to openThread with lastViewedTurnId as initial turn
        await get().openThread(threadId, thread.lastViewedTurnId ?? undefined, signal)
      },

      createThread: async (projectId: string, title: string) => {
        set({ isLoadingThreads: true, error: null })
        try {
          const thread = await api.threads.create(projectId, title)

          set((state) => ({
            threads: [...state.threads, thread],
            isLoadingThreads: false,
          }))
          return thread
        } catch (error) {
          const message = getErrorMessageWithFallback(error, 'Failed to create thread')
          set({ error: message, isLoadingThreads: false })
          throw error
        }
      },

      renameThread: async (threadId: string, title: string) => {
        set({ error: null })
        try {
          const updated = await api.threads.update(threadId, title)

          set((state) => ({
            threads: state.threads.map((c) => (c.id === threadId ? updated : c)),
          }))
        } catch (error) {
          set({ error: getErrorMessageWithFallback(error, 'Failed to rename thread') })
          throw error
        }
      },

      createTurn: async (threadId: string, messageText: string, options: ThreadRequestOptions) => {
        // Skeleton - optimistic updates implemented in Phase 4 Task 4.7
        set({ error: null })
        try {
          // Determine prevTurnId from the last turn in the current list
          const currentTurns = get().turns
          const lastTurn = currentTurns[currentTurns.length - 1]
          const prevTurnId = lastTurn ? lastTurn.id : null

          const { userTurn, assistantTurn, streamUrl } = await api.turns.send(messageText, {
            threadId,
            prevTurnId,
            requestOptions: options,
          })

          // Response contains both user's turn and assistant's turn (streaming handled via SSE)
          const newTurns = [userTurn, assistantTurn]
          set((state) => {
            const mergedById = new Map<string, Turn>()
            for (const t of [...state.turns, ...newTurns]) mergedById.set(t.id, t)
            return {
              turns: Array.from(mergedById.values()),
              streamingTurnId: assistantTurn.id,
              streamingUrl: streamUrl,
            }
          })

          // Update bookmark to the new assistant turn
          await updateLastViewedTurnBookmark(threadId, assistantTurn.id)
        } catch (error) {
          set({ error: getErrorMessageWithFallback(error, 'Failed to send message') })
          throw error
        }
      },

      startNewThread: async (
        projectId: string,
        messageText: string,
        options: ThreadRequestOptions
      ): Promise<Thread> => {
        // Cold-start: atomically create thread + first turn in one request
        set({ error: null })
        try {
          const { thread, userTurn, assistantTurn, streamUrl } = await api.turns.send(messageText, {
            projectId,
            requestOptions: options,
          })

          if (!thread) {
            throw new Error('Expected new thread in response but received none')
          }

          // Add the new thread and its turns to state
          set((state) => ({
            threads: [thread, ...state.threads],
            threadId: thread.id,
            turns: [userTurn, assistantTurn],
            currentTurnId: assistantTurn.id,
            streamingTurnId: assistantTurn.id,
            streamingUrl: streamUrl,
          }))

          return thread
        } catch (error) {
          set({ error: getErrorMessageWithFallback(error, 'Failed to start new thread') })
          throw error
        }
      },

      deleteThread: async (threadId: string) => {
        set({ error: null })
        try {
          await api.threads.delete(threadId)

          set((state) => ({
            threads: state.threads.filter((c) => c.id !== threadId),
            turns: state.turns.filter((t) => t.threadId !== threadId),
          }))
        } catch (error) {
          set({ error: getErrorMessageWithFallback(error, 'Failed to delete thread') })
          throw error
        }
      },

      interruptStreamingTurn: async () => {
        const log = makeLogger('thread-store')
        const state = get()
        const turnId = state.streamingTurnId
        const threadId = state.threadId

        if (!turnId) {
          return
        }

        set({ error: null })
        log.debug('interruptStreamingTurn:start', { turnId, threadId })

        try {
          await api.turns.interrupt(turnId)

          // Best-effort refresh so UI sees partial content and updated status.
          if (threadId) {
            await state.refreshTurn(threadId, turnId)
          }
        } catch (error) {
          set({ error: getErrorMessageWithFallback(error, 'Failed to interrupt streaming turn') })
        }
      },

      appendStreamingTextDelta: (
        turnId: string,
        blockIndex: number,
        blockType: string,
        delta: string
      ) => {
        if (!delta) return

        set((state) => {
          const turns = state.turns.map((turn) => {
            if (turn.id !== turnId) return turn

            const sequence = blockIndex
            const existingIndex = turn.blocks.findIndex((b) => b.sequence === sequence)

            // No existing block for this sequence → create a new one
            if (existingIndex === -1) {
              const newBlock = {
                id: `${turn.id}:${sequence}`,
                turnId: turn.id,
                blockType: blockType as import('@/features/threads/types').BlockType,
                sequence,
                textContent: delta,
                content: undefined,
                createdAt: new Date(),
              }

              const blocks = [...turn.blocks, newBlock].sort((a, b) => a.sequence - b.sequence)
              return { ...turn, blocks }
            }

            // Update existing block by appending text
            const blocks = turn.blocks.map((block, index) => {
              if (index !== existingIndex) return block
              const text = block.textContent ?? ''
              return {
                ...block,
                blockType: (block.blockType || blockType) as import('@/features/threads/types').BlockType,
                textContent: text + delta,
              }
            })

            return { ...turn, blocks }
          })

          return { turns }
        })
      },

      setStreamingBlockContent: (
        turnId: string,
        blockIndex: number,
        blockType: string,
        content: Record<string, unknown>
      ) => {
        set((state) => {
          const turns = state.turns.map((turn) => {
            if (turn.id !== turnId) return turn

            const sequence = blockIndex
            const existingIndex = turn.blocks.findIndex((b) => b.sequence === sequence)

            if (existingIndex === -1) {
              const newBlock = {
                id: `${turn.id}:${sequence}`,
                turnId: turn.id,
                blockType: blockType as import('@/features/threads/types').BlockType,
                sequence,
                textContent: undefined,
                content,
                createdAt: new Date(),
              }
              const blocks = [...turn.blocks, newBlock].sort((a, b) => a.sequence - b.sequence)
              return { ...turn, blocks }
            }

            const blocks = turn.blocks.map((block, index) => {
              if (index !== existingIndex) return block
              return {
                ...block,
                blockType: (block.blockType || blockType) as import('@/features/threads/types').BlockType,
                content,
              }
            })

            return { ...turn, blocks }
          })

          return { turns }
        })
      },

      clearStreamingStream: () => {
        set(() => ({
          streamingTurnId: null,
          streamingUrl: null,
          streamingBlockIndex: null,
          streamingBlockType: null,
        }))
      },

      setStreamingBlockInfo: (
        blockIndex: number | null,
        blockType: BlockType | null
      ) => {
        set(() => ({
          streamingBlockIndex: blockIndex,
          streamingBlockType: blockType,
        }))
      },

      setCurrentTurnId: (turnId: string) => {
        set(() => ({ currentTurnId: turnId }))
      },

      openThread: async (threadId: string, initialTurnId?: string, signal?: AbortSignal) => {
        const log = makeLogger('thread-store')
        log.debug('openThread:start', { threadId, initialTurnId })
        // Set threadId immediately so remounts can detect in-flight loads and avoid
        // redundant re-fetches that cause "progressive reload" UI.
        set({ threadId, isLoadingTurns: true, error: null })
        try {
          const { turns, hasMoreBefore, hasMoreAfter } = await api.turns.paginate(threadId, {
            fromTurnId: initialTurnId,
            // Force both for initial load to guarantee context renders even if server defaults act unexpectedly.
            direction: 'both',
            limit: 100,
            signal,
          })
          log.debug('openThread:response', {
            count: turns.length,
            hasMoreBefore,
            hasMoreAfter,
            first: turns[0]?.id,
            last: turns[turns.length - 1]?.id,
          })
          const mergedById = new Map<string, Turn>()
          for (const t of turns) mergedById.set(t.id, t)
          const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined
          const nextCurrent = initialTurnId ?? (lastTurn ? lastTurn.id : null)
          const turnsArray = Array.from(mergedById.values())
          set({
            threadId,
            turns: turnsArray,
            currentTurnId: nextCurrent,
            hasMoreBefore,
            hasMoreAfter,
            isLoadingTurns: false,
            ...detectStreamingState(turnsArray),
          })
          log.debug('openThread:set', { threadId, currentTurnId: nextCurrent, total: mergedById.size })
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isLoadingTurns: false })
            log.debug('openThread:aborted', { threadId })
            return
          }
          log.error('openThread:error', error)
          set({ error: getErrorMessageWithFallback(error, 'Failed to open thread'), isLoadingTurns: false })
        }
      },

      paginateBefore: async (signal?: AbortSignal) => {
        const state = get()
        if (!state.threadId || state.turns.length === 0) return
        const top = state.turns[0]
        if (!top) {
          set({ isLoadingTurns: false })
          return
        }
        const log = makeLogger('thread-store')
        log.debug('paginateBefore:start', { threadId: state.threadId, fromTurnId: top.id })
        set({ isLoadingTurns: true, error: null })
        try {
          const { turns, hasMoreBefore } = await api.turns.paginate(state.threadId, {
            fromTurnId: top.id,
            direction: 'before',
            limit: 100,
            signal,
          })
          log.debug('paginateBefore:response', {
            loaded: turns.length,
            hasMoreBefore,
            first: turns[0]?.id,
            last: turns[turns.length - 1]?.id,
          })
          // Prepend older turns (chronological order preserved by backend)
          const mergedById = new Map<string, Turn>()
          for (const t of [...turns, ...state.turns]) mergedById.set(t.id, t)
          const turnsArray = Array.from(mergedById.values())
          set({
            turns: turnsArray,
            hasMoreBefore,
            isLoadingTurns: false,
            ...detectStreamingState(turnsArray),
          })
          log.debug('paginateBefore:set', { total: mergedById.size })
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isLoadingTurns: false })
            log.debug('paginateBefore:aborted')
            return
          }
          log.error('paginateBefore:error', error)
          set({ error: getErrorMessageWithFallback(error, 'Failed to load older messages'), isLoadingTurns: false })
        }
      },

      paginateAfter: async (signal?: AbortSignal) => {
        const state = get()
        if (!state.threadId || state.turns.length === 0) return
        const bottom = state.turns[state.turns.length - 1]
        if (!bottom) {
          set({ isLoadingTurns: false })
          return
        }
        const log = makeLogger('thread-store')
        log.debug('paginateAfter:start', { threadId: state.threadId, fromTurnId: bottom.id })
        set({ isLoadingTurns: true, error: null })
        try {
          const { turns, hasMoreAfter } = await api.turns.paginate(state.threadId, {
            fromTurnId: bottom.id,
            direction: 'after',
            limit: 100,
            updateLastViewed: true, // Update bookmark when scrolling down
            signal,
          })
          log.debug('paginateAfter:response', {
            loaded: turns.length,
            hasMoreAfter,
            first: turns[0]?.id,
            last: turns[turns.length - 1]?.id,
          })
          // Append newer turns
          const mergedById = new Map<string, Turn>()
          for (const t of [...state.turns, ...turns]) mergedById.set(t.id, t)
          const turnsArray = Array.from(mergedById.values())
          set({
            turns: turnsArray,
            hasMoreAfter,
            isLoadingTurns: false,
            ...detectStreamingState(turnsArray),
          })
          log.debug('paginateAfter:set', { total: mergedById.size })
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isLoadingTurns: false })
            log.debug('paginateAfter:aborted')
            return
          }
          log.error('paginateAfter:error', error)
          set({ error: getErrorMessageWithFallback(error, 'Failed to load newer messages'), isLoadingTurns: false })
        }
      },

      switchSibling: async (threadId: string, targetTurnId: string, signal?: AbortSignal) => {
        const log = makeLogger('thread-store')
        log.debug('switchSibling:start', { threadId, targetTurnId })

        const state = get()

        // Cancel previous request if it exists
        if (state.navigationAbortController) {
          state.navigationAbortController.abort()
        }

        const controller = new AbortController()
        set({ navigationAbortController: controller, isLoadingTurns: true, error: null })

        try {
          const { turns, hasMoreBefore, hasMoreAfter } = await api.turns.paginate(threadId, {
            fromTurnId: targetTurnId,
            direction: 'both',
            limit: 100,
            updateLastViewed: true, // Explicit bookmarking on sibling switch
            signal: controller.signal ?? signal,
          })
          log.debug('switchSibling:response', {
            count: turns.length,
            hasMoreBefore,
            hasMoreAfter,
            first: turns[0]?.id,
            last: turns[turns.length - 1]?.id,
          })

          const mergedById = new Map<string, Turn>()
          for (const t of turns) mergedById.set(t.id, t)

          // Only update if not aborted
          if (!controller.signal.aborted) {
            const turnsArray = Array.from(mergedById.values())
            set({
              threadId,
              turns: turnsArray,
              currentTurnId: targetTurnId,
              hasMoreBefore,
              hasMoreAfter,
              isLoadingTurns: false,
              navigationAbortController: null, // Clear after success
              ...detectStreamingState(turnsArray),
            })
            log.debug('switchSibling:set', { threadId, currentTurnId: targetTurnId, total: mergedById.size })
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            log.debug('switchSibling:aborted')
            return
          }
          log.error('switchSibling:error', error)
          set({ error: getErrorMessageWithFallback(error, 'Failed to navigate'), isLoadingTurns: false, navigationAbortController: null })
        }
      },

      editTurn: async (threadId: string, turnId: string | undefined, messageText: string, options?: ThreadRequestOptions) => {
        set({ isLoadingTurns: true, error: null })
        try {
          // Find the original turn to get its prevTurnId
          // If turnId is undefined, we assume we are editing a root turn (or creating a new one?)
          // But the signature says turnId is the one being edited.
          const currentTurns = get().turns
          const originalTurn = turnId ? currentTurns.find((t) => t.id === turnId) : undefined
          const prevTurnId = originalTurn ? originalTurn.prevTurnId : null

          // Call createTurn endpoint with the SAME prevTurnId as the original turn
          // This creates a sibling branch.
          // Use provided options or fall back to defaults
          const { assistantTurn } = await api.turns.send(messageText, {
            threadId,
            prevTurnId,
            requestOptions: options ?? DEFAULT_THREAD_REQUEST_OPTIONS,
          })

          // Navigate to the new branch (the assistant turn leaf)
          // This ensures pagination includes the full thread context
          await get().switchSibling(threadId, assistantTurn.id)
        } catch (error) {
          set({ error: getErrorMessageWithFallback(error, 'Failed to edit turn'), isLoadingTurns: false })
        }
      },

      regenerateTurn: async (threadId: string, assistantTurnId: string) => {
        set({ isLoadingTurns: true, error: null })
        try {
          const currentTurns = get().turns
          const assistantTurn = currentTurns.find((t) => t.id === assistantTurnId)

          if (!assistantTurn) {
             throw new Error('Assistant turn not found')
          }

          // Find the preceding user turn
          const userTurnId = assistantTurn.prevTurnId
          const userTurn = userTurnId ? currentTurns.find((t) => t.id === userTurnId) : undefined

          if (!userTurn) {
             throw new Error('Parent user turn not found for regeneration')
          }

          // Rebuild plain-text content from the user's text blocks
          const userMessageText = userTurn.blocks
            .filter((b) => b.blockType === 'text')
            .map((b) => b.textContent ?? '')
            .join('\n\n')

          // Use the original assistant turn's request params for regeneration
          // This preserves the model, provider, thinking level, etc.
          const requestOptions = requestParamsToOptions(assistantTurn.requestParams)

          // Re-send the user's content to create a new sibling response
          const { userTurn: newUserTurn } = await api.turns.send(
            userMessageText,
            {
              threadId,
              prevTurnId: userTurn.prevTurnId,
              requestOptions,
            }
          )

          // Navigate to the new branch
          await get().switchSibling(threadId, newUserTurn.id)
        } catch (error) {
          set({ error: getErrorMessageWithFallback(error, 'Failed to regenerate'), isLoadingTurns: false })
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'thread-store',
      // For MVP we bypass Dexie for turns entirely.
      // TODO(DEXIE): Implement windowed Dexie caching for threads (last 100 turns) and re-enable cache policies here.
      partialize: () => ({}),
    }
  )
)
