import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ThreadRequestOptions, RequestParams } from '@/features/threads/types'
import { DEFAULT_THREAD_REQUEST_OPTIONS, requestParamsToOptions } from '@/features/threads/types'

interface ThreadPrefsState {
  // Global default (persisted to localStorage)
  // Used when starting new threads or when thread has no history
  globalOptions: ThreadRequestOptions

  // Current session options (for the active input)
  // Not persisted - reset on page reload, then re-initialized from thread history
  currentOptions: ThreadRequestOptions

  /**
   * Initialize options for a thread. Priority:
   * 1. Per-thread (lastTurnParams) - if thread has history
   * 2. Global preference (persisted from last selection)
   * 3. Hardcoded default (fallback)
   *
   * @param threadId - undefined for new threads (always uses global)
   * @param lastTurnParams - from thread history
   */
  initOptionsForThread: (threadId: string | undefined, lastTurnParams?: RequestParams | null) => void

  /**
   * Update options from manual user selection (dropdown).
   * Saves to both current AND global (persists preference).
   */
  updateOptionsManually: (options: ThreadRequestOptions) => void
}

export const useThreadPrefsStore = create<ThreadPrefsState>()(
  persist(
    (set, get) => ({
      globalOptions: DEFAULT_THREAD_REQUEST_OPTIONS,
      currentOptions: DEFAULT_THREAD_REQUEST_OPTIONS,

      initOptionsForThread: (threadId, lastTurnParams) => {
        // New thread (no threadId) - always use global, ignore stale turns data
        if (!threadId) {
          set({ currentOptions: get().globalOptions })
          return
        }

        // Existing thread - use thread history if available, else global
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
      name: 'thread-prefs',
      // Only persist globalOptions - currentOptions is session-only
      // Exclude tools from persistence - always use DEFAULT_TOOLS to ensure new tools appear
      partialize: (state) => ({
        globalOptions: { ...state.globalOptions, tools: undefined }
      }),
    }
  )
)
