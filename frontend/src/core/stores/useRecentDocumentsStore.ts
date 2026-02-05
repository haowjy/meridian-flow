import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface RecentDocument {
  documentId: string
  accessedAt: number // timestamp
}

interface RecentDocumentsState {
  // Map of projectId → recent documents (most recent first)
  recentByProject: Record<string, RecentDocument[]>

  // Actions
  addRecent: (projectId: string, documentId: string) => void
  removeRecent: (projectId: string, documentId: string) => void
  clearProject: (projectId: string) => void
}

const MAX_RECENT_PER_PROJECT = 20

export const useRecentDocumentsStore = create<RecentDocumentsState>()(
  persist(
    (set) => ({
      recentByProject: {},

      addRecent: (projectId, documentId) => {
        set((state) => {
          const existing = state.recentByProject[projectId] ?? []
          // Remove if already exists (will be re-added at front)
          const filtered = existing.filter((r) => r.documentId !== documentId)
          // Prepend new entry
          const updated = [
            { documentId, accessedAt: Date.now() },
            ...filtered,
          ].slice(0, MAX_RECENT_PER_PROJECT)

          return {
            recentByProject: {
              ...state.recentByProject,
              [projectId]: updated,
            },
          }
        })
      },

      removeRecent: (projectId, documentId) => {
        set((state) => {
          const existing = state.recentByProject[projectId]
          if (!existing) return state

          const filtered = existing.filter((r) => r.documentId !== documentId)
          return {
            recentByProject: {
              ...state.recentByProject,
              [projectId]: filtered,
            },
          }
        })
      },

      clearProject: (projectId) => {
        set((state) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [projectId]: _removed, ...rest } = state.recentByProject
          return { recentByProject: rest }
        })
      },
    }),
    {
      name: 'recent-documents',
      version: 1,
      partialize: (state) => ({
        recentByProject: state.recentByProject,
      }),
    }
  )
)
