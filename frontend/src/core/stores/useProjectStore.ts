import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Project } from '@/features/projects/types/project'
import { api } from '@/core/lib/api'
import { handleApiError } from '@/core/lib/errors'
import { editorCache } from '@/core/editor/cache'

type LoadStatus = 'idle' | 'loading' | 'success' | 'error'

interface ProjectStore {
  currentProjectId: string | null
  projects: Project[]
  status: LoadStatus
  isFetching: boolean
  error: string | null

  // Computed getter for backwards compatibility
  isLoading: boolean

  currentProject: () => Project | null
  setCurrentProject: (project: Project | null) => void
  loadProjects: () => Promise<void>
  createProject: (name: string) => Promise<Project>
  updateProject: (id: string, name: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
}

/**
 * Module-level AbortController for loadProjects requests.
 *
 * Pattern: Single shared controller ensures only one loadProjects request is active at a time.
 * When a new loadProjects call starts, it aborts the previous request to prevent race conditions.
 *
 * Why module-level:
 * - Projects are global to the app (not per-component instance)
 * - Simple cancellation without store state pollution
 * - Avoids memory leaks from concurrent project list fetches
 *
 * Alternative considered: Store-level controller - rejected as it adds unnecessary state complexity
 */
let loadProjectsController: AbortController | null = null

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set, get) => ({
      currentProjectId: null,
      projects: [],
      status: 'idle' as LoadStatus,
      isFetching: false,
      error: null,

      // Computed getter for backwards compatibility
      get isLoading() {
        return get().status === 'loading'
      },

      currentProject: () => {
        const state = get()
        if (!state.currentProjectId) return null
        return state.projects.find((p) => p.id === state.currentProjectId) || null
      },

      setCurrentProject: (project) => {
        // Clear editor cache only when actually switching away from a non-null project
        const prevId = get().currentProjectId
        const nextId = project?.id || null
        if (prevId && prevId !== nextId) {
          editorCache.clear()
        }
        set({ currentProjectId: nextId })
      },

      loadProjects: async () => {
        // Abort any previous loadProjects request
        if (loadProjectsController) {
          loadProjectsController.abort()
        }

        // Create new controller for this request
        loadProjectsController = new AbortController()
        const signal = loadProjectsController.signal

        // Set loading state based on whether we have cached data
        const currentState = get()
        const status = currentState.projects.length === 0 ? 'loading' : 'success'
        set({ status, isFetching: true, error: null })

        try {
          const projects = await api.projects.list({ signal })
          set({ projects, status: 'success', isFetching: false })
        } catch (error) {
          // Handle AbortError silently
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isFetching: false })
            return
          }

          const message = error instanceof Error ? error.message : 'Failed to load projects'
          // If we have cached data, keep status as 'success', otherwise set to 'error'
          const currentProjects = get().projects
          const errorStatus = currentProjects.length > 0 ? 'success' : 'error'
          set({ error: message, status: errorStatus, isFetching: false })
          handleApiError(error, 'Failed to load projects. Please check your connection.')
        }
      },

      createProject: async (name) => {
        set({ error: null })
        try {
          const project = await api.projects.create(name)
          set((state) => ({
            projects: [...state.projects, project],
          }))
          return project
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create project'
          set({ error: message })
          handleApiError(error, 'Failed to create project')
          throw error
        }
      },

      updateProject: async (id, name) => {
        try {
          const updated = await api.projects.update(id, name)
          set((state) => ({
            projects: state.projects.map((p) => (p.id === id ? updated : p)),
          }))
        } catch (error) {
          handleApiError(error, 'Failed to update project')
          throw error
        }
      },

      deleteProject: async (id) => {
        try {
          await api.projects.delete(id)
          set((state) => ({
            projects: state.projects.filter((p) => p.id !== id),
            currentProjectId: state.currentProjectId === id ? null : state.currentProjectId,
          }))
        } catch (error) {
          handleApiError(error, 'Failed to delete project')
          throw error
        }
      },
    }),
    {
      name: 'project-store',
      partialize: (state) => ({
        currentProjectId: state.currentProjectId,
        projects: state.projects, // Cache projects list for instant load
      }),
    }
  )
)
