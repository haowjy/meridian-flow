import type { OnboardingState } from "../jsonb.js";

export type OnboardingAnswers = Record<string, unknown>;

export interface OnboardingStatusResponse {
  state: OnboardingState;
  projectCount: number;
  shouldOnboard: boolean;
}

export interface OnboardingProgressRequest {
  stepId: string;
  answers: OnboardingAnswers;
}

export interface OnboardingProgressResponse {
  state: OnboardingState;
}

export interface OnboardingCompleteRequest {
  path: "import_corpus" | "start_chatting";
}

export interface OnboardingCompleteResponse {
  state: OnboardingState;
  projectId: string;
  threadId: string;
}
