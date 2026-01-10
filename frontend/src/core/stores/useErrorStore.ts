import { create } from 'zustand'

interface ErrorStore {
  // Network status
  isOffline: boolean
  setIsOffline: (offline: boolean) => void

  // Session expiry (401 from API)
  sessionExpired: boolean
  setSessionExpired: (expired: boolean) => void
  clearSessionExpired: () => void

  // Initialize network listeners (call once at app root)
  initNetworkListeners: () => () => void
}

/**
 * Global error store for app-wide error states.
 *
 * Manages:
 * - Network connectivity status (offline/online)
 * - Session expiry (401 responses trigger re-auth modal)
 *
 * Usage:
 * - Components subscribe via `useErrorStore()`
 * - API interceptor can call `useErrorStore.getState().setSessionExpired(true)` outside React
 * - Call `initNetworkListeners()` once in app root to start monitoring connectivity
 */
export const useErrorStore = create<ErrorStore>()((set) => ({
  isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
  sessionExpired: false,

  setIsOffline: (offline) => set({ isOffline: offline }),

  setSessionExpired: (expired) => set({ sessionExpired: expired }),

  clearSessionExpired: () => set({ sessionExpired: false }),

  initNetworkListeners: () => {
    const handleOnline = () => set({ isOffline: false })
    const handleOffline = () => set({ isOffline: true })

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Return cleanup function
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  },
}))
