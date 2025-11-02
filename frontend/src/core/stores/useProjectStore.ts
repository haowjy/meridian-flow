import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Project } from '@/features/projects/types/project'
import { api } from '@/core/lib/api'
import { toast } from 'sonner'

interface ProjectStore {
  currentProject: Project | null
  projects: Project[]
  isLoading: boolean
  error: string | null

  setCurrentProject: (project: Project | null) => void
  loadProjects: () => Promise<void>
  createProject: (name: string) => Promise<Project>
  updateProject: (id: string, name: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set) => ({
      currentProject: null,
      projects: [],
      isLoading: false,
      error: null,

      setCurrentProject: (project) => set({ currentProject: project }),

      loadProjects: async () => {
        set({ isLoading: true, error: null })
        try {
          const projects = await api.projects.list()
          set({ projects, isLoading: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load projects'
          set({ error: message, isLoading: false })
          toast.error('Failed to load projects. Please check your connection.')
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
          toast.success('Project created!')
          return project
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create project'
          set({ error: message, isLoading: false })
          toast.error('Failed to create project')
          throw error
        }
      },

      updateProject: async (id, name) => {
        try {
          const updated = await api.projects.update(id, name)
          set((state) => ({
            projects: state.projects.map((p) => (p.id === id ? updated : p)),
            currentProject: state.currentProject?.id === id ? updated : state.currentProject,
          }))
          toast.success('Project updated!')
        } catch (error) {
          toast.error('Failed to update project')
          throw error
        }
      },

      deleteProject: async (id) => {
        try {
          await api.projects.delete(id)
          set((state) => ({
            projects: state.projects.filter((p) => p.id !== id),
            currentProject: state.currentProject?.id === id ? null : state.currentProject,
          }))
          toast.success('Project deleted')
        } catch (error) {
          toast.error('Failed to delete project')
          throw error
        }
      },
    }),
    {
      name: 'project-store',
      partialize: (state) => ({
        currentProject: state.currentProject,
      }),
    }
  )
)
