import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Project } from '@/features/projects/types/project'

interface ProjectStore {
  currentProject: Project | null
  projects: Project[]

  setCurrentProject: (project: Project | null) => void
  loadProjects: () => Promise<void>
  createProject: (name: string) => Promise<Project>
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set) => ({
      currentProject: null,
      projects: [],

      setCurrentProject: (project) => set({ currentProject: project }),
      loadProjects: async () => {
        // TODO: Implement in Phase 3
      },
      createProject: async (name) => {
        // TODO: Implement in Phase 3
        throw new Error('Not implemented')
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
