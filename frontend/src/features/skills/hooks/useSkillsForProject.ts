import { useSkillStore } from '@/core/stores/useSkillStore'
import { useShallow } from 'zustand/react/shallow'
import { useAbortableEffect } from '@/core/hooks'
import type { Skill, SkillWithContent } from '../types/skill'

export interface UseSkillsForProjectResult {
  skills: Skill[]
  status: 'idle' | 'loading' | 'success' | 'error'
  isLoading: boolean
  error: string | null
  selectedSkillId: string | null
  selectedSkillContent: SkillWithContent | null
  isLoadingSelectedSkill: boolean
  setSelectedSkillId: (skillId: string | null) => void
}

/**
 * Hook to load and manage skills for a project.
 * Handles abort controller lifecycle and data loading.
 */
export function useSkillsForProject(projectId: string | null): UseSkillsForProjectResult {
  const {
    skills,
    skillsStatus,
    isLoadingSkills,
    error,
    selectedSkillId,
    selectedSkillContent,
    isLoadingSelectedSkill,
    loadSkills,
    loadSkillContent,
    setSelectedSkillId,
  } = useSkillStore(
    useShallow((s) => ({
      skills: s.skills,
      skillsStatus: s.skillsStatus,
      isLoadingSkills: s.isLoadingSkills,
      error: s.error,
      selectedSkillId: s.selectedSkillId,
      selectedSkillContent: s.selectedSkillContent,
      isLoadingSelectedSkill: s.isLoadingSelectedSkill,
      loadSkills: s.loadSkills,
      loadSkillContent: s.loadSkillContent,
      setSelectedSkillId: s.setSelectedSkillId,
    }))
  )

  // Load skills when projectId changes
  useAbortableEffect(
    (signal) => {
      if (!projectId) return
      void loadSkills(projectId, signal)
    },
    [projectId, loadSkills]
  )

  // Load skill content when selectedSkillId changes
  useAbortableEffect(
    (signal) => {
      if (!projectId || !selectedSkillId) return
      void loadSkillContent(projectId, selectedSkillId, signal)
    },
    [projectId, selectedSkillId, loadSkillContent]
  )

  return {
    skills,
    status: skillsStatus,
    isLoading: isLoadingSkills,
    error,
    selectedSkillId,
    selectedSkillContent,
    isLoadingSelectedSkill,
    setSelectedSkillId,
  }
}
