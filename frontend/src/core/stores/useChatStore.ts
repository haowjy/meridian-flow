import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Chat, Turn } from '@/features/chats/types'
import { api } from '@/core/lib/api'
import { handleApiError } from '@/core/lib/errors'
import { db } from '@/core/lib/db'
import { loadWithPolicy, NetworkFirstPolicy, bulkCacheUpdate, windowedCacheUpdate, ICacheRepo, IRemoteRepo } from '@/core/lib/cache'

interface ChatStore {
  chats: Chat[]
  turns: Turn[]
  isLoadingChats: boolean
  isLoadingTurns: boolean
  error: string | null

  loadChats: (projectId: string, signal?: AbortSignal) => Promise<void>
  loadTurns: (chatId: string, signal?: AbortSignal) => Promise<void>
  createChat: (projectId: string, title: string) => Promise<Chat>
  renameChat: (chatId: string, title: string) => Promise<void>
  createTurn: (chatId: string, content: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      chats: [],
      turns: [],
      isLoadingChats: false,
      isLoadingTurns: false,
      error: null,

      loadChats: async (projectId: string, signal?: AbortSignal) => {
        set({ isLoadingChats: true, error: null })
        try {
          const cacheRepo: ICacheRepo<Chat[]> = {
            get: async () => {
              const cached = await db.chats.where('projectId').equals(projectId).toArray()
              return cached.length > 0 ? cached : undefined
            },
            put: async (chats) => {
              await bulkCacheUpdate(db.chats, chats)
            },
          }
          const remoteRepo: IRemoteRepo<Chat[]> = {
            fetch: (s) => api.chats.list(projectId, { signal: s }),
          }

          const result = await loadWithPolicy<Chat[]>(new NetworkFirstPolicy<Chat[]>(), {
            cacheRepo,
            remoteRepo,
            signal,
            onIntermediate: (r) => set({ chats: r.data, isLoadingChats: false }),
          })

          set({ chats: result.data, isLoadingChats: false })
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
        set({ isLoadingTurns: true, error: null })
        try {
          const cacheRepoTurns: ICacheRepo<Turn[]> = {
            get: async () => {
              const cached = await db.messages.where('chatId').equals(chatId).toArray()
              return cached.length > 0 ? cached : undefined
            },
            put: async (turns) => {
              await windowedCacheUpdate(db.messages, `chat-${chatId}`, turns, 100)
            },
          }
          const remoteRepoTurns: IRemoteRepo<Turn[]> = {
            fetch: (s) => api.turns.list(chatId, { signal: s }),
          }

          const resultTurns = await loadWithPolicy<Turn[]>(new NetworkFirstPolicy<Turn[]>(), {
            cacheRepo: cacheRepoTurns,
            remoteRepo: remoteRepoTurns,
            signal,
            onIntermediate: (r) => set({ turns: r.data, isLoadingTurns: false }),
          })

          set({ turns: resultTurns.data, isLoadingTurns: false })
        } catch (error) {
          // Handle AbortError silently
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isLoadingTurns: false })
            return
          }

          const message = error instanceof Error ? error.message : 'Failed to load messages'
          set({ error: message, isLoadingTurns: false })
          handleApiError(error, 'Failed to load messages')
        }
      },

      createChat: async (projectId: string, title: string) => {
        set({ isLoadingChats: true, error: null })
        try {
          const chat = await api.chats.create(projectId, title)

          // Update IndexedDB cache
          await db.chats.put(chat)

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

          // Update IndexedDB cache
          await db.chats.put(updated)

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
          const response = await api.turns.send(chatId, content)

          // Response contains both user's turn and assistant's turn (streaming handled separately)
          // Update IndexedDB cache with windowing (only keep last 100)
          const newTurns = [response.userTurn, response.assistantTurn]
          const allTurns = [...get().turns, ...newTurns]
          await windowedCacheUpdate(db.messages, `chat-${chatId}`, allTurns, 100)

          set((state) => ({
            turns: [...state.turns, response.userTurn, response.assistantTurn],
          }))
        } catch (error) {
          handleApiError(error, 'Failed to send message')
          throw error
        }
      },

      deleteChat: async (chatId: string) => {
        try {
          await api.chats.delete(chatId)

          // Remove from IndexedDB cache (chat + all its messages)
          await db.chats.delete(chatId)
          await db.messages.where('chatId').equals(chatId).delete()

          set((state) => ({
            chats: state.chats.filter((c) => c.id !== chatId),
            turns: state.turns.filter((t) => t.chatId !== chatId),
          }))
        } catch (error) {
          handleApiError(error, 'Failed to delete chat')
          throw error
        }
      },
    }),
    {
      name: 'chat-store',
      // No persisted fields yet; chats/turns are cached via IndexedDB instead.
      partialize: () => ({}),
    }
  )
)
