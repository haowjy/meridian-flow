import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Chat, Message } from '@/features/chats/types'
import { api } from '@/core/lib/api'
import { handleApiError } from '@/core/lib/errors'
import { db } from '@/core/lib/db'
import { loadWithPolicy, NetworkFirstPolicy, bulkCacheUpdate, windowedCacheUpdate, ICacheRepo, IRemoteRepo } from '@/core/lib/cache'

interface ChatStore {
  chats: Chat[]
  messages: Message[]
  activeChatId: string | null
  isLoadingChats: boolean
  isLoadingMessages: boolean
  error: string | null

  activeChat: () => Chat | null
  setActiveChat: (chat: Chat | null) => void
  loadChats: (projectId: string, signal?: AbortSignal) => Promise<void>
  loadMessages: (chatId: string, signal?: AbortSignal) => Promise<void>
  createChat: (projectId: string, title: string) => Promise<Chat>
  renameChat: (chatId: string, title: string) => Promise<void>
  sendMessage: (chatId: string, content: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      chats: [],
      messages: [],
      activeChatId: null,
      isLoadingChats: false,
      isLoadingMessages: false,
      error: null,

      activeChat: () => {
        const state = get()
        if (!state.activeChatId) return null
        return state.chats.find((c) => c.id === state.activeChatId) || null
      },

      setActiveChat: (chat) => set({ activeChatId: chat?.id || null }),

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

      loadMessages: async (chatId: string, signal?: AbortSignal) => {
        set({ isLoadingMessages: true, error: null })
        try {
          const cacheRepoMsgs: ICacheRepo<Message[]> = {
            get: async () => {
              const cached = await db.messages.where('chatId').equals(chatId).toArray()
              return cached.length > 0 ? cached : undefined
            },
            put: async (messages) => {
              await windowedCacheUpdate(db.messages, `chat-${chatId}`, messages, 100)
            },
          }
          const remoteRepoMsgs: IRemoteRepo<Message[]> = {
            fetch: (s) => api.messages.list(chatId, { signal: s }),
          }

          const resultMsgs = await loadWithPolicy<Message[]>(new NetworkFirstPolicy<Message[]>(), {
            cacheRepo: cacheRepoMsgs,
            remoteRepo: remoteRepoMsgs,
            signal,
            onIntermediate: (r) => set({ messages: r.data, isLoadingMessages: false }),
          })

          set({ messages: resultMsgs.data, isLoadingMessages: false })
        } catch (error) {
          // Handle AbortError silently
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isLoadingMessages: false })
            return
          }

          const message = error instanceof Error ? error.message : 'Failed to load messages'
          set({ error: message, isLoadingMessages: false })
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

      sendMessage: async (chatId: string, content: string) => {
        // Skeleton - optimistic updates implemented in Phase 4 Task 4.7
        try {
          const response = await api.messages.send(chatId, content)

          // Update IndexedDB cache with windowing (only keep last 100)
          const newMessages = [response.userMessage, response.assistantMessage]
          const allMessages = [...get().messages, ...newMessages]
          await windowedCacheUpdate(db.messages, `chat-${chatId}`, allMessages, 100)

          set((state) => ({
            messages: [...state.messages, response.userMessage, response.assistantMessage],
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
            activeChatId: state.activeChatId === chatId ? null : state.activeChatId,
            messages: state.activeChatId === chatId ? [] : state.messages,
          }))
        } catch (error) {
          handleApiError(error, 'Failed to delete chat')
          throw error
        }
      },
    }),
    {
      name: 'chat-store',
      partialize: (state) => ({
        activeChatId: state.activeChatId,
      }),
    }
  )
)
