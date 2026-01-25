import { create } from 'zustand'
import { api } from '@/core/lib/api'
import type { Skill, SkillWithContent, CreateSkillRequest, UpdateSkillRequest } from '@/features/skills/types/skill'

type SkillStatus = 'idle' | 'loading' | 'success' | 'error'

interface SkillStoreState {
  // State
  skills: Skill[]
  skillsStatus: SkillStatus
  isLoadingSkills: boolean
  error: string | null
  currentProjectId: string | null

  // Selected skill (for detail view)
  selectedSkillId: string | null
  selectedSkillContent: SkillWithContent | null
  isLoadingSelectedSkill: boolean

  // Actions
  loadSkills: (projectId: string, signal: AbortSignal) => Promise<void>
  loadSkillContent: (projectId: string, skillId: string, signal: AbortSignal) => Promise<void>
  createSkill: (projectId: string, data: CreateSkillRequest) => Promise<Skill>
  updateSkill: (projectId: string, skillId: string, data: UpdateSkillRequest) => Promise<Skill>
  deleteSkill: (projectId: string, skillId: string) => Promise<void>
  reorderSkills: (projectId: string, skillIds: string[]) => Promise<void>
  setSelectedSkillId: (skillId: string | null) => void
  clearSkills: () => void
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  // Initial state
  skills: [],
  skillsStatus: 'idle',
  isLoadingSkills: false,
  error: null,
  currentProjectId: null,
  selectedSkillId: null,
  selectedSkillContent: null,
  isLoadingSelectedSkill: false,

  loadSkills: async (projectId: string, signal: AbortSignal) => {
    set({ skillsStatus: 'loading', isLoadingSkills: true, error: null, currentProjectId: projectId })

    try {
      const skills = await api.skills.list(projectId, { signal })
      // Sort by position
      skills.sort((a, b) => a.position - b.position)
      set({ skills, skillsStatus: 'success', isLoadingSkills: false })
    } catch (error) {
      // Silent abort errors
      if (error instanceof Error && error.name === 'AbortError') {
        return
      }
      set({
        skillsStatus: 'error',
        isLoadingSkills: false,
        error: error instanceof Error ? error.message : 'Failed to load skills',
      })
    }
  },

  loadSkillContent: async (projectId: string, skillId: string, signal: AbortSignal) => {
    set({ isLoadingSelectedSkill: true })

    try {
      const skill = await api.skills.get(projectId, skillId, { signal })
      set({ selectedSkillContent: skill, isLoadingSelectedSkill: false })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return
      }
      set({ isLoadingSelectedSkill: false })
      throw error
    }
  },

  createSkill: async (projectId: string, data: CreateSkillRequest) => {
    const skill = await api.skills.create(projectId, data)

    // Add to local state
    set((state) => ({
      skills: [...state.skills, skill].sort((a, b) => a.position - b.position),
    }))

    return skill
  },

  updateSkill: async (projectId: string, skillId: string, data: UpdateSkillRequest) => {
    const updatedSkill = await api.skills.update(projectId, skillId, data)

    // Update in local state
    set((state) => ({
      skills: state.skills.map((s) => (s.id === skillId ? updatedSkill : s)),
      // Update selected content if it's the same skill
      selectedSkillContent:
        state.selectedSkillContent?.id === skillId
          ? { ...state.selectedSkillContent, ...updatedSkill }
          : state.selectedSkillContent,
    }))

    return updatedSkill
  },

  deleteSkill: async (projectId: string, skillId: string) => {
    await api.skills.delete(projectId, skillId)

    // Remove from local state
    set((state) => ({
      skills: state.skills.filter((s) => s.id !== skillId),
      selectedSkillId: state.selectedSkillId === skillId ? null : state.selectedSkillId,
      selectedSkillContent: state.selectedSkillContent?.id === skillId ? null : state.selectedSkillContent,
    }))
  },

  reorderSkills: async (projectId: string, skillIds: string[]) => {
    await api.skills.reorder(projectId, skillIds)

    // Update local positions
    set((state) => ({
      skills: skillIds.map((id, index) => {
        const skill = state.skills.find((s) => s.id === id)
        if (!skill) return null
        return { ...skill, position: index }
      }).filter((s): s is Skill => s !== null),
    }))
  },

  setSelectedSkillId: (skillId: string | null) => {
    set({
      selectedSkillId: skillId,
      // Clear content when deselecting
      selectedSkillContent: skillId === null ? null : get().selectedSkillContent,
    })
  },

  clearSkills: () => {
    set({
      skills: [],
      skillsStatus: 'idle',
      isLoadingSkills: false,
      error: null,
      currentProjectId: null,
      selectedSkillId: null,
      selectedSkillContent: null,
      isLoadingSelectedSkill: false,
    })
  },
}))
