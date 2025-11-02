import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Chat, Message } from '@/features/chats/types'
import { api } from '@/core/lib/api'
import { handleApiError } from '@/core/lib/errors'

interface ChatStore {
  chats: Chat[]
  messages: Message[]
  activeChatId: string | null
  isLoadingChats: boolean
  isLoadingMessages: boolean
  error: string | null

  activeChat: () => Chat | null
  setActiveChat: (chat: Chat | null) => void
  loadChats: (projectId: string) => Promise<void>
  loadMessages: (chatId: string) => Promise<void>
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

      loadChats: async (projectId: string) => {
        set({ isLoadingChats: true, error: null })
        try {
          const chats = await api.chats.list(projectId)
          set({ chats, isLoadingChats: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load chats'
          set({ error: message, isLoadingChats: false })
          handleApiError(error, 'Failed to load chats')
        }
      },

      loadMessages: async (chatId: string) => {
        set({ isLoadingMessages: true, error: null })
        try {
          const messages = await api.messages.list(chatId)
          set({ messages, isLoadingMessages: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load messages'
          set({ error: message, isLoadingMessages: false })
          handleApiError(error, 'Failed to load messages')
        }
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

      sendMessage: async (chatId: string, content: string) => {
        // Skeleton - optimistic updates implemented in Phase 4 Task 4.7
        try {
          const response = await api.messages.send(chatId, content)
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
