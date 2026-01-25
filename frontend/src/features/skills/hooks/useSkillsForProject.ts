import { useEffect, useRef } from 'react'
import { useSkillStore } from '@/core/stores/useSkillStore'
import { useShallow } from 'zustand/react/shallow'
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

  const abortRef = useRef<AbortController | null>(null)
  const contentAbortRef = useRef<AbortController | null>(null)

  // Load skills when projectId changes
  useEffect(() => {
    if (!projectId) return

    // Cancel previous request
    if (abortRef.current) {
      abortRef.current.abort()
    }

    const abortController = new AbortController()
    abortRef.current = abortController

    void loadSkills(projectId, abortController.signal)

    return () => {
      abortController.abort()
    }
  }, [projectId, loadSkills])

  // Load skill content when selectedSkillId changes
  useEffect(() => {
    if (!projectId || !selectedSkillId) return

    // Cancel previous content request
    if (contentAbortRef.current) {
      contentAbortRef.current.abort()
    }

    const abortController = new AbortController()
    contentAbortRef.current = abortController

    void loadSkillContent(projectId, selectedSkillId, abortController.signal)

    return () => {
      abortController.abort()
    }
  }, [projectId, selectedSkillId, loadSkillContent])

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
