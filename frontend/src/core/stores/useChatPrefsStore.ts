import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChatRequestOptions, RequestParams } from '@/features/chats/types'
import { DEFAULT_CHAT_REQUEST_OPTIONS, requestParamsToOptions } from '@/features/chats/types'

interface ChatPrefsState {
  // Global default (persisted to localStorage)
  // Used when starting new chats or when conversation has no history
  globalOptions: ChatRequestOptions

  // Current session options (for the active input)
  // Not persisted - reset on page reload, then re-initialized from chat history
  currentOptions: ChatRequestOptions

  /**
   * Initialize options for a chat. Priority:
   * 1. Per-conversation (lastTurnParams) - if chat has history
   * 2. Global preference (persisted from last selection)
   * 3. Hardcoded default (fallback)
   *
   * @param chatId - undefined for new chats (always uses global)
   * @param lastTurnParams - from conversation history
   */
  initOptionsForChat: (chatId: string | undefined, lastTurnParams?: RequestParams | null) => void

  /**
   * Update options from manual user selection (dropdown).
   * Saves to both current AND global (persists preference).
   */
  updateOptionsManually: (options: ChatRequestOptions) => void
}

export const useChatPrefsStore = create<ChatPrefsState>()(
  persist(
    (set, get) => ({
      globalOptions: DEFAULT_CHAT_REQUEST_OPTIONS,
      currentOptions: DEFAULT_CHAT_REQUEST_OPTIONS,

      initOptionsForChat: (chatId, lastTurnParams) => {
        // New chat (no chatId) - always use global, ignore stale turns data
        if (!chatId) {
          set({ currentOptions: get().globalOptions })
          return
        }

        // Existing chat - use conversation history if available, else global
        const resolved = lastTurnParams
          ? requestParamsToOptions(lastTurnParams)
          : get().globalOptions
        set({ currentOptions: resolved })
      },

      updateOptionsManually: (options) => set({
        currentOptions: options,
        globalOptions: options,
      }),
    }),
    {
      name: 'chat-prefs',
      // Only persist globalOptions - currentOptions is session-only
      partialize: (state) => ({ globalOptions: state.globalOptions }),
    }
  )
)
