import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Chat, Turn } from '@/features/chats/types'
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
interface ChatStore {
  chats: Chat[]
  turns: Turn[]
  chatId: string | null
  currentTurnId: string | null
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  isLoadingChats: boolean
  isLoadingTurns: boolean
  error: string | null
  navigationAbortController: AbortController | null

  loadChats: (projectId: string, signal?: AbortSignal) => Promise<void>
  // Legacy shape retained; internally calls openChat
  loadTurns: (chatId: string, signal?: AbortSignal) => Promise<void>
  createChat: (projectId: string, title: string) => Promise<Chat>
  renameChat: (chatId: string, title: string) => Promise<void>
  createTurn: (chatId: string, content: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>

  // Pagination & navigation (server-driven)
  openChat: (chatId: string, initialTurnId?: string, signal?: AbortSignal) => Promise<void>
  paginateBefore: (signal?: AbortSignal) => Promise<void>
  paginateAfter: (signal?: AbortSignal) => Promise<void>
  switchSibling: (chatId: string, targetTurnId: string, signal?: AbortSignal) => Promise<void>
  editTurn: (chatId: string, parentTurnId: string | undefined, content: string) => Promise<void>
  regenerateTurn: (chatId: string, parentTurnId: string) => Promise<void>
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
      isLoadingChats: false,
      isLoadingTurns: false,
      error: null,
      navigationAbortController: null,

      loadChats: async (projectId: string, signal?: AbortSignal) => {
        set({ isLoadingChats: true, error: null })
        try {
          // Network-first for chats; keep Dexie for chats if needed in future
          const data = await api.chats.list(projectId, { signal })
          set({ chats: data, isLoadingChats: false })
        } catch (error) {
          // Handle AbortError silently
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isLoadingChats: false })
            return
          }

          const message = error instanceof Error ? error.message : 'Failed to load chats'
          set({ error: message, isLoadingChats: false })
          handleApiError(error, 'Failed to load chats')
        }
      },

      loadTurns: async (chatId: string, signal?: AbortSignal) => {
        // For MVP, delegate to openChat with no initial turn (cold start)
        await get().openChat(chatId, undefined, signal)
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

      createTurn: async (chatId: string, content: string) => {
        // Skeleton - optimistic updates implemented in Phase 4 Task 4.7
        try {
          // Determine prevTurnId from the last turn in the current list
          const currentTurns = get().turns
          const lastTurn = currentTurns[currentTurns.length - 1]
          const prevTurnId = lastTurn ? lastTurn.id : null

          const response = await api.turns.send(chatId, content, { prevTurnId })

          // Response contains both user's turn and assistant's turn (streaming handled separately)
          const newTurns = [response.userTurn, response.assistantTurn]
          set((state) => {
            const mergedById = new Map<string, Turn>()
            for (const t of [...state.turns, ...newTurns]) mergedById.set(t.id, t)
            return { turns: Array.from(mergedById.values()) }
          })
        } catch (error) {
          handleApiError(error, 'Failed to send message')
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
          set({
            chatId,
            turns: Array.from(mergedById.values()),
            currentTurnId: nextCurrent,
            hasMoreBefore,
            hasMoreAfter,
            isLoadingTurns: false,
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
          set({
            turns: Array.from(mergedById.values()),
            hasMoreBefore,
            isLoadingTurns: false,
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
          set({
            turns: Array.from(mergedById.values()),
            hasMoreAfter,
            isLoadingTurns: false,
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
            set({
              chatId,
              turns: Array.from(mergedById.values()),
              currentTurnId: targetTurnId,
              hasMoreBefore,
              hasMoreAfter,
              isLoadingTurns: false,
              navigationAbortController: null, // Clear after success
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

      editTurn: async (chatId: string, turnId: string | undefined, content: string) => {
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
          const { userTurn } = await api.turns.send(chatId, content, { prevTurnId })

          // Navigate to the new branch (the new user turn)
          await get().switchSibling(chatId, userTurn.id)
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

          // Re-send the user's content to create a new sibling response
          const { userTurn: newUserTurn } = await api.turns.send(chatId, userTurn.content, { 
            prevTurnId: userTurn.prevTurnId 
          })

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
