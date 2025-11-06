import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Project } from '@/features/projects/types/project'
import { api } from '@/core/lib/api'
import { handleApiError } from '@/core/lib/errors'
import { clearEditorCache } from '@/core/hooks/useEditorCache'
import { useNavigationStore } from '@/core/stores/useNavigationStore'

interface ProjectStore {
  currentProjectId: string | null
  projects: Project[]
  isLoading: boolean
  error: string | null

  currentProject: () => Project | null
  setCurrentProject: (project: Project | null) => void
  loadProjects: () => Promise<void>
  createProject: (name: string) => Promise<Project>
  updateProject: (id: string, name: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
}

// Track abort controller to cancel previous loadProjects request
let loadProjectsController: AbortController | null = null

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set, get) => ({
      currentProjectId: null,
      projects: [],
      isLoading: false,
      error: null,

      currentProject: () => {
        const state = get()
        if (!state.currentProjectId) return null
        return state.projects.find((p) => p.id === state.currentProjectId) || null
      },

      setCurrentProject: (project) => {
        // Clear editor cache and navigation history when switching projects
        // to prevent stale data and memory leaks
        clearEditorCache()
        useNavigationStore.getState().clear()
        set({ currentProjectId: project?.id || null })
      },

      loadProjects: async () => {
        // Abort any previous loadProjects request
        if (loadProjectsController) {
          loadProjectsController.abort()
        }

        // Create new controller for this request
        loadProjectsController = new AbortController()
        const signal = loadProjectsController.signal

        set({ isLoading: true, error: null })
        try {
          const projects = await api.projects.list({ signal })
          set({ projects, isLoading: false })
        } catch (error) {
          // Handle AbortError silently
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isLoading: false })
            return
          }

          const message = error instanceof Error ? error.message : 'Failed to load projects'
          set({ error: message, isLoading: false })
          handleApiError(error, 'Failed to load projects. Please check your connection.')
        }
      },

      createProject: async (name) => {
        set({ isLoading: true, error: null })
        try {
          const project = await api.projects.create(name)
          set((state) => ({
            projects: [...state.projects, project],
            isLoading: false,
          }))
          return project
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create project'
          set({ error: message, isLoading: false })
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
