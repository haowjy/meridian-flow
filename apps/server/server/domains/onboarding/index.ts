import type { OnboardingState } from "@meridian/contracts";
import type {
  OnboardingCompleteRequest,
  OnboardingCompleteResponse,
  OnboardingProgressRequest,
  OnboardingProgressResponse,
  OnboardingStatusResponse,
} from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import type {
  ProjectBootstrapRepository,
  ProjectRepository,
  UserRepository,
} from "../projects/index.js";

export interface OnboardingServiceDeps {
  users: UserRepository;
  projects: ProjectBootstrapRepository;
  projectRepo: ProjectRepository;
}

export interface OnboardingService {
  status(userId: UserId): Promise<OnboardingStatusResponse>;
  saveProgress(
    userId: UserId,
    input: OnboardingProgressRequest,
  ): Promise<OnboardingProgressResponse>;
  complete(userId: UserId, input: OnboardingCompleteRequest): Promise<OnboardingCompleteResponse>;
}

export function shouldRouteToOnboarding(state: OnboardingState, projectCount: number): boolean {
  if (state.status === "completed") return false;
  if (state.status === "in_progress") return true;
  return projectCount === 0;
}

export function createOnboardingService(deps: OnboardingServiceDeps): OnboardingService {
  async function readStatus(userId: UserId): Promise<OnboardingStatusResponse> {
    const [state, projects] = await Promise.all([
      deps.users.getOnboardingState(userId),
      deps.projectRepo.listByUser(userId),
    ]);
    return {
      state,
      projectCount: projects.length,
      shouldOnboard: shouldRouteToOnboarding(state, projects.length),
    };
  }

  function mergedAnswers(state: OnboardingState, input: OnboardingProgressRequest) {
    return { ...(state.answers ?? {}), ...input.answers };
  }

  async function ensureOnboardingBootstrap(userId: UserId, state: OnboardingState) {
    if (state.firstProjectId && state.firstThreadId) return state;
    const answers = state.answers ?? {};
    const bootstrap = await deps.projects.createOnboardingBootstrap(userId, {
      name: stringAnswer(answers.projectName) ?? stringAnswer(answers.workingTitle),
      writingType: stringAnswer(answers.writingType),
      writingGoal: stringAnswer(answers.writingGoal),
      notes: stringAnswer(answers.notes),
    });
    return {
      ...state,
      firstProjectId: bootstrap.projectId,
      firstThreadId: bootstrap.threadId,
      workId: bootstrap.workId,
      documentId: bootstrap.documentId,
      contextSourceId: bootstrap.contextSourceId,
    };
  }

  return {
    async status(userId) {
      return readStatus(userId);
    },
    async saveProgress(userId, input) {
      const current = await deps.users.getOnboardingState(userId);
      const next = await ensureOnboardingBootstrap(userId, {
        ...current,
        status: "in_progress",
        currentStep: input.stepId,
        completedSteps: unique([...(current.completedSteps ?? []), input.stepId]),
        answers: mergedAnswers(current, input),
      });
      return { state: await deps.users.updateOnboardingState(userId, next) };
    },
    async complete(userId, input) {
      const current = await deps.users.getOnboardingState(userId);
      const bootstrapped = await ensureOnboardingBootstrap(userId, current);
      const next = await deps.users.updateOnboardingState(userId, {
        ...bootstrapped,
        status: "completed",
        currentStep: "complete",
        completedSteps: unique([...(bootstrapped.completedSteps ?? []), "complete"]),
        selectedPath: input.path,
      });
      if (!next.firstProjectId || !next.firstThreadId) {
        throw new Error("Onboarding completion did not create a project thread");
      }
      return {
        state: next,
        projectId: next.firstProjectId,
        threadId: next.firstThreadId,
      };
    },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stringAnswer(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
