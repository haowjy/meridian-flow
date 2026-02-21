import { create } from "zustand";
import { api } from "@/core/lib/api";
import { getErrorMessageWithFallback } from "@/core/lib/errors";
import {
  runBackgroundRetrieval,
  shouldClearActiveSelection,
} from "@/core/retrieval";
import type {
  Skill,
  SkillWithContent,
  CreateSkillRequest,
  UpdateSkillRequest,
} from "@/features/skills/types/skill";

type SkillStatus = "idle" | "loading" | "success" | "error";
let loadSkillsRequestId = 0;

interface SkillStoreState {
  // State
  skills: Skill[];
  skillsStatus: SkillStatus;
  isLoadingSkills: boolean;
  error: string | null;
  currentProjectId: string | null;
  /** Timestamp of last successful skills fetch (prevents redundant fetches on tab switch) */
  skillsLoadedAt: number | null;

  // Selected skill (for detail view)
  selectedSkillId: string | null;
  selectedSkillContent: SkillWithContent | null;
  isLoadingSelectedSkill: boolean;

  // Actions
  loadSkills: (projectId: string, signal: AbortSignal) => Promise<void>;
  loadSkillContent: (
    projectId: string,
    skillId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  createSkill: (projectId: string, data: CreateSkillRequest) => Promise<Skill>;
  updateSkill: (
    projectId: string,
    skillId: string,
    data: UpdateSkillRequest,
  ) => Promise<Skill>;
  deleteSkill: (projectId: string, skillId: string) => Promise<void>;
  setSelectedSkillId: (skillId: string | null) => void;
  clearSkills: () => void;
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  // Initial state
  skills: [],
  skillsStatus: "idle",
  isLoadingSkills: false,
  error: null,
  currentProjectId: null,
  skillsLoadedAt: null,
  selectedSkillId: null,
  selectedSkillContent: null,
  isLoadingSelectedSkill: false,

  loadSkills: async (projectId: string, signal: AbortSignal) => {
    const requestId = ++loadSkillsRequestId;
    const state = get();
    // Stale-while-revalidate: show cached data immediately if same project
    const hasCachedData =
      state.skills.length > 0 && state.currentProjectId === projectId;

    // Skip if data is fresh (< 30s old) for the same project.
    // Prevents redundant fetches when Activity re-fires effects on tab switch.
    const isFresh =
      hasCachedData &&
      state.skillsLoadedAt !== null &&
      Date.now() - state.skillsLoadedAt < 30_000;
    if (isFresh) return;

    await runBackgroundRetrieval({
      hasCachedData,
      isStale: () => requestId !== loadSkillsRequestId,
      onBegin: (mode) => {
        if (mode === "initial") {
          // No cache or different project: show loading state
          set({
            skillsStatus: "loading",
            isLoadingSkills: true,
            error: null,
            currentProjectId: projectId,
          });
          return;
        }

        // Has cache for same project: keep showing cached data, fetch in background
        set({ isLoadingSkills: true, error: null });
      },
      retrieve: () => api.skills.list(projectId, { signal }),
      onSuccess: (skills) => {
        // Sort by position
        const sortedSkills = [...skills].sort((a, b) => a.position - b.position);
        set((state) => {
          const shouldClearSelectedSkill =
            state.selectedSkillId !== null &&
            !sortedSkills.some((skill) => skill.id === state.selectedSkillId);
          return {
            skills: sortedSkills,
            skillsStatus: "success",
            isLoadingSkills: false,
            skillsLoadedAt: Date.now(),
            selectedSkillId: shouldClearSelectedSkill ? null : state.selectedSkillId,
            selectedSkillContent: shouldClearSelectedSkill
              ? null
              : state.selectedSkillContent,
          };
        });
      },
      onAbort: () => {
        // Clear loading flag on abort to prevent stuck loading state
        set({ isLoadingSkills: false });
      },
      onError: (error) => {
        // On error with cached data for same project, keep showing cached data
        const hasData =
          get().skills.length > 0 && get().currentProjectId === projectId;
        set({
          skillsStatus: hasData ? "success" : "error",
          isLoadingSkills: false,
          error: getErrorMessageWithFallback(error, "Failed to load skills"),
        });
      },
    });
  },

  loadSkillContent: async (
    projectId: string,
    skillId: string,
    signal: AbortSignal,
  ) => {
    set({ isLoadingSelectedSkill: true });

    try {
      const skill = await api.skills.get(projectId, skillId, { signal });
      set({ selectedSkillContent: skill, isLoadingSelectedSkill: false });
    } catch (error) {
      // Clear loading flag on abort to prevent stuck loading state
      if (error instanceof Error && error.name === "AbortError") {
        set({ isLoadingSelectedSkill: false });
        return;
      }
      if (shouldClearActiveSelection("skill:getById", error)) {
        set({
          selectedSkillId: null,
          selectedSkillContent: null,
          isLoadingSelectedSkill: false,
          error: getErrorMessageWithFallback(error, "Skill not found"),
        });
        return;
      }
      set({ isLoadingSelectedSkill: false });
      throw error;
    }
  },

  createSkill: async (projectId: string, data: CreateSkillRequest) => {
    const skill = await api.skills.create(projectId, data);

    // Add to local state
    set((state) => ({
      skills: [...state.skills, skill].sort((a, b) => a.position - b.position),
    }));

    return skill;
  },

  updateSkill: async (
    projectId: string,
    skillId: string,
    data: UpdateSkillRequest,
  ) => {
    const updatedSkill = await api.skills.update(projectId, skillId, data);

    // Update in local state
    set((state) => ({
      skills: state.skills.map((s) => (s.id === skillId ? updatedSkill : s)),
      // Update selected content if it's the same skill
      selectedSkillContent:
        state.selectedSkillContent?.id === skillId
          ? { ...state.selectedSkillContent, ...updatedSkill }
          : state.selectedSkillContent,
    }));

    return updatedSkill;
  },

  deleteSkill: async (projectId: string, skillId: string) => {
    await api.skills.delete(projectId, skillId);

    // Remove from local state
    set((state) => ({
      skills: state.skills.filter((s) => s.id !== skillId),
      selectedSkillId:
        state.selectedSkillId === skillId ? null : state.selectedSkillId,
      selectedSkillContent:
        state.selectedSkillContent?.id === skillId
          ? null
          : state.selectedSkillContent,
    }));
  },

  setSelectedSkillId: (skillId: string | null) => {
    set({
      selectedSkillId: skillId,
      // Clear content when deselecting
      selectedSkillContent:
        skillId === null ? null : get().selectedSkillContent,
    });
  },

  clearSkills: () => {
    set({
      skills: [],
      skillsStatus: "idle",
      isLoadingSkills: false,
      error: null,
      currentProjectId: null,
      skillsLoadedAt: null,
      selectedSkillId: null,
      selectedSkillContent: null,
      isLoadingSelectedSkill: false,
    });
  },
}));
