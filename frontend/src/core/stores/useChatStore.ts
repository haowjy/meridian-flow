import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  Chat,
  Turn,
  type BlockType,
  type ChatRequestOptions,
} from '@/features/chats/types'
import { DEFAULT_CHAT_REQUEST_OPTIONS, requestParamsToOptions } from '@/features/chats/types'
import { api } from '@/core/lib/api'
import { handleApiError } from '@/core/lib/errors'
import { makeLogger } from '@/core/lib/logger'

/**
 * TODO(DEXIE CACHING) - High Priority Follow-up:
 * Implement windowed Dexie caching for chat turns (last ~100 items) and re-enable
 * cache policies for fast warm loads and offline fallback. Current MVP intentionally
 * bypasses Dexie for turns to simplify server-driven pagination integration.
 * - Cache shape: messages table keyed by chatId with createdAt index
 * - Strategy: windowed write-through on paginate/send; hydrate on openChat
 * - Ensure no duplication and preserve chronological order on merges
 */
type LoadStatus = 'idle' | 'loading' | 'success' | 'error'

interface ChatStore {
  chats: Chat[]
  turns: Turn[]
  chatId: string | null
  currentTurnId: string | null
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  statusChats: LoadStatus
  isFetchingChats: boolean
  isLoadingTurns: boolean
  error: string | null
  navigationAbortController: AbortController | null

  // Computed getter for backwards compatibility
  isLoadingChats: boolean

  // Streaming state for the currently active assistant turn (at most one)
  streamingTurnId: string | null
  streamingUrl: string | null
  streamingBlockIndex: number | null
  streamingBlockType: BlockType | null

  loadChats: (projectId: string, signal?: AbortSignal) => Promise<void>
  // Legacy shape retained; internally calls openChat
  loadTurns: (chatId: string, signal?: AbortSignal) => Promise<void>
  createChat: (projectId: string, title: string) => Promise<Chat>
  renameChat: (chatId: string, title: string) => Promise<void>
  createTurn: (chatId: string, messageText: string, options: ChatRequestOptions) => Promise<void>
  // Cold-start: creates a new chat atomically with the first turn
  startNewChat: (projectId: string, messageText: string, options: ChatRequestOptions) => Promise<Chat>
  deleteChat: (chatId: string) => Promise<void>

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

  interruptStreamingTurn: () => Promise<void>

  // Pagination & navigation (server-driven)
  openChat: (chatId: string, initialTurnId?: string, signal?: AbortSignal) => Promise<void>
  paginateBefore: (signal?: AbortSignal) => Promise<void>
  paginateAfter: (signal?: AbortSignal) => Promise<void>
  switchSibling: (chatId: string, targetTurnId: string, signal?: AbortSignal) => Promise<void>
  editTurn: (chatId: string, parentTurnId: string | undefined, content: string, options?: ChatRequestOptions) => Promise<void>
  regenerateTurn: (chatId: string, parentTurnId: string) => Promise<void>
  refreshTurn: (chatId: string, turnId: string) => Promise<void>
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
const updateLastViewedTurnBookmark = async (chatId: string, turnId: string) => {
  try {
    await api.chats.updateLastViewedTurn(chatId, turnId)
  } catch (err) {
    const log = makeLogger('chat-store')
    log.warn('Failed to update last_viewed_turn_id', { chatId, turnId, error: err })
  }
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      chats: [],
      turns: [],
      chatId: null,
      currentTurnId: null,
      hasMoreBefore: false,
      hasMoreAfter: false,
      statusChats: 'idle' as LoadStatus,
      isFetchingChats: false,
      isLoadingTurns: false,
      error: null,
      navigationAbortController: null,
      streamingTurnId: null,
      streamingUrl: null,
       streamingBlockIndex: null,
       streamingBlockType: null,

      // Computed getter for backwards compatibility
      get isLoadingChats() {
        return get().statusChats === 'loading'
      },

      refreshTurn: async (chatId: string, turnId: string) => {
        try {
          const blocks = await api.turns.getBlocks(turnId)
          set((state) => {
            const turns = state.turns.map((turn) => {
              if (turn.id !== turnId) return turn
              return { ...turn, blocks }
            })
            return { turns }
          })
        } catch (error) {
          handleApiError(error, 'Failed to refresh turn')
        }
      },

      loadChats: async (projectId: string, signal?: AbortSignal) => {
        // Set loading state based on whether we have cached chat data
        const currentState = get()
        const status = currentState.chats.length === 0 ? 'loading' : 'success'
        set({ statusChats: status, isFetchingChats: true, error: null })

        try {
          // Network-first for chats; keep Dexie for chats if needed in future
          const data = await api.chats.list(projectId, { signal })
          set({ chats: data, statusChats: 'success', isFetchingChats: false })
        } catch (error) {
          // Handle AbortError silently
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isFetchingChats: false })
            return
          }

          const message = error instanceof Error ? error.message : 'Failed to load chats'
          // If we have cached chats, keep status as 'success', otherwise set to 'error'
          const currentChats = get().chats
          const errorStatus = currentChats.length > 0 ? 'success' : 'error'
          set({ error: message, statusChats: errorStatus, isFetchingChats: false })
          handleApiError(error, 'Failed to load chats')
        }
      },

      loadTurns: async (chatId: string, signal?: AbortSignal) => {
        // Fetch chat to get lastViewedTurnId for auto-scroll
        const chat = await api.chats.get(chatId)
        // Delegate to openChat with lastViewedTurnId as initial turn
        await get().openChat(chatId, chat.lastViewedTurnId ?? undefined, signal)
      },

      createChat: async (projectId: string, title: string) => {
        set({ isLoadingChats: true, error: null })
        try {
          const chat = await api.chats.create(projectId, title)

          set((state) => ({
            chats: [...state.chats, chat],
            isLoadingChats: false,
          }))
          return chat
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create chat'
          set({ error: message, isLoadingChats: false })
          handleApiError(error, 'Failed to create chat')
          throw error
        }
      },

      renameChat: async (chatId: string, title: string) => {
        try {
          const updated = await api.chats.update(chatId, title)

          set((state) => ({
            chats: state.chats.map((c) => (c.id === chatId ? updated : c)),
          }))
        } catch (error) {
          handleApiError(error, 'Failed to rename chat')
          throw error
        }
      },

      createTurn: async (chatId: string, messageText: string, options: ChatRequestOptions) => {
        // Skeleton - optimistic updates implemented in Phase 4 Task 4.7
        try {
          // Determine prevTurnId from the last turn in the current list
          const currentTurns = get().turns
          const lastTurn = currentTurns[currentTurns.length - 1]
          const prevTurnId = lastTurn ? lastTurn.id : null

          const { userTurn, assistantTurn, streamUrl } = await api.turns.send(messageText, {
            chatId,
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
          await updateLastViewedTurnBookmark(chatId, assistantTurn.id)
        } catch (error) {
          handleApiError(error, 'Failed to send message')
          throw error
        }
      },

      startNewChat: async (
        projectId: string,
        messageText: string,
        options: ChatRequestOptions
      ): Promise<Chat> => {
        // Cold-start: atomically create chat + first turn in one request
        try {
          const { chat, userTurn, assistantTurn, streamUrl } = await api.turns.send(messageText, {
            projectId,
            requestOptions: options,
          })

          if (!chat) {
            throw new Error('Expected new chat in response but received none')
          }

          // Add the new chat and its turns to state
          set((state) => ({
            chats: [chat, ...state.chats],
            chatId: chat.id,
            turns: [userTurn, assistantTurn],
            currentTurnId: assistantTurn.id,
            streamingTurnId: assistantTurn.id,
            streamingUrl: streamUrl,
          }))

          return chat
        } catch (error) {
          handleApiError(error, 'Failed to start new chat')
          throw error
        }
      },

      deleteChat: async (chatId: string) => {
        try {
          await api.chats.delete(chatId)

          set((state) => ({
            chats: state.chats.filter((c) => c.id !== chatId),
            turns: state.turns.filter((t) => t.chatId !== chatId),
          }))
        } catch (error) {
          handleApiError(error, 'Failed to delete chat')
          throw error
        }
      },

      interruptStreamingTurn: async () => {
        const log = makeLogger('chat-store')
        const state = get()
        const turnId = state.streamingTurnId
        const chatId = state.chatId

        if (!turnId) {
          return
        }

        log.debug('interruptStreamingTurn:start', { turnId, chatId })

        try {
          await api.turns.interrupt(turnId)

          // Best-effort refresh so UI sees partial content and updated status.
          if (chatId) {
            await state.refreshTurn(chatId, turnId)
          }
        } catch (error) {
          handleApiError(error, 'Failed to interrupt streaming turn')
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
                blockType: blockType as import('@/features/chats/types').BlockType,
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
                blockType: (block.blockType || blockType) as import('@/features/chats/types').BlockType,
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
                blockType: blockType as import('@/features/chats/types').BlockType,
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
                blockType: (block.blockType || blockType) as import('@/features/chats/types').BlockType,
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

      openChat: async (chatId: string, initialTurnId?: string, signal?: AbortSignal) => {
        const log = makeLogger('chat-store')
        log.debug('openChat:start', { chatId, initialTurnId })
        set({ isLoadingTurns: true, error: null })
        try {
          const { turns, hasMoreBefore, hasMoreAfter } = await api.turns.paginate(chatId, {
            fromTurnId: initialTurnId,
            // Force both for initial load to guarantee context renders even if server defaults act unexpectedly.
            direction: 'both',
            limit: 100,
            signal,
          })
          log.debug('openChat:response', {
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
            chatId,
            turns: turnsArray,
            currentTurnId: nextCurrent,
            hasMoreBefore,
            hasMoreAfter,
            isLoadingTurns: false,
            ...detectStreamingState(turnsArray),
          })
          log.debug('openChat:set', { chatId, currentTurnId: nextCurrent, total: mergedById.size })
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isLoadingTurns: false })
            log.debug('openChat:aborted', { chatId })
            return
          }
          log.error('openChat:error', error)
          set({ error: 'Failed to open chat', isLoadingTurns: false })
          handleApiError(error, 'Failed to open chat')
        }
      },

      paginateBefore: async (signal?: AbortSignal) => {
        const state = get()
        if (!state.chatId || state.turns.length === 0) return
        const top = state.turns[0]
        if (!top) {
          set({ isLoadingTurns: false })
          return
        }
        const log = makeLogger('chat-store')
        log.debug('paginateBefore:start', { chatId: state.chatId, fromTurnId: top.id })
        set({ isLoadingTurns: true })
        try {
          const { turns, hasMoreBefore } = await api.turns.paginate(state.chatId, {
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
          set({ error: 'Failed to load older messages', isLoadingTurns: false })
          handleApiError(error, 'Failed to load older messages')
        }
      },

      paginateAfter: async (signal?: AbortSignal) => {
        const state = get()
        if (!state.chatId || state.turns.length === 0) return
        const bottom = state.turns[state.turns.length - 1]
        if (!bottom) {
          set({ isLoadingTurns: false })
          return
        }
        const log = makeLogger('chat-store')
        log.debug('paginateAfter:start', { chatId: state.chatId, fromTurnId: bottom.id })
        set({ isLoadingTurns: true })
        try {
          const { turns, hasMoreAfter } = await api.turns.paginate(state.chatId, {
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
          set({ error: 'Failed to load newer messages', isLoadingTurns: false })
          handleApiError(error, 'Failed to load newer messages')
        }
      },

      switchSibling: async (chatId: string, targetTurnId: string, signal?: AbortSignal) => {
        const log = makeLogger('chat-store')
        log.debug('switchSibling:start', { chatId, targetTurnId })

        const state = get()

        // Cancel previous request if it exists
        if (state.navigationAbortController) {
          state.navigationAbortController.abort()
        }

        const controller = new AbortController()
        set({ navigationAbortController: controller, isLoadingTurns: true })

        try {
          const { turns, hasMoreBefore, hasMoreAfter } = await api.turns.paginate(chatId, {
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
              chatId,
              turns: turnsArray,
              currentTurnId: targetTurnId,
              hasMoreBefore,
              hasMoreAfter,
              isLoadingTurns: false,
              navigationAbortController: null, // Clear after success
              ...detectStreamingState(turnsArray),
            })
            log.debug('switchSibling:set', { chatId, currentTurnId: targetTurnId, total: mergedById.size })
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            log.debug('switchSibling:aborted')
            return
          }
          log.error('switchSibling:error', error)
          set({ error: 'Failed to navigate', isLoadingTurns: false, navigationAbortController: null })
          handleApiError(error, 'Failed to navigate')
        }
      },

      editTurn: async (chatId: string, turnId: string | undefined, messageText: string, options?: ChatRequestOptions) => {
        set({ isLoadingTurns: true })
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
            chatId,
            prevTurnId,
            requestOptions: options ?? DEFAULT_CHAT_REQUEST_OPTIONS,
          })

          // Navigate to the new branch (the assistant turn leaf)
          // This ensures pagination includes the full conversation context
          await get().switchSibling(chatId, assistantTurn.id)
        } catch (error) {
          set({ error: 'Failed to edit turn', isLoadingTurns: false })
          handleApiError(error, 'Failed to edit turn')
        }
      },

      regenerateTurn: async (chatId: string, assistantTurnId: string) => {
        set({ isLoadingTurns: true })
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
              chatId,
              prevTurnId: userTurn.prevTurnId,
              requestOptions,
            }
          )

          // Navigate to the new branch
          await get().switchSibling(chatId, newUserTurn.id)
        } catch (error) {
          set({ error: 'Failed to regenerate', isLoadingTurns: false })
          handleApiError(error, 'Failed to regenerate')
        }
      },
    }),
    {
      name: 'chat-store',
      // For MVP we bypass Dexie for turns entirely.
      // TODO(DEXIE): Implement windowed Dexie caching for conversations (last 100 turns) and re-enable cache policies here.
      partialize: () => ({}),
    }
  )
)
