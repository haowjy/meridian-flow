import type {
  OnboardingCompleteRequest,
  OnboardingCompleteResponse,
  OnboardingProgressRequest,
  OnboardingProgressResponse,
  OnboardingStatusResponse,
} from "@meridian/contracts/protocol";
import {
  apiOnboardingCompletePath,
  apiOnboardingPath,
  apiOnboardingProgressPath,
} from "@meridian/contracts/protocol";
import { getJson, postJson } from "./http-client";

export type RequestInitOptions = {
  origin?: string;
  headers?: HeadersInit;
};

function urlFor(path: string, init?: RequestInitOptions): string {
  return init?.origin ? new URL(path, init.origin).toString() : path;
}

export function getOnboardingStatus(init?: RequestInitOptions): Promise<OnboardingStatusResponse> {
  return getJson<OnboardingStatusResponse>(urlFor(apiOnboardingPath(), init), {
    headers: init?.headers,
  });
}

export function saveOnboardingProgress(
  body: OnboardingProgressRequest,
): Promise<OnboardingProgressResponse> {
  return postJson<OnboardingProgressResponse>(apiOnboardingProgressPath(), body);
}

export function completeOnboarding(
  body: OnboardingCompleteRequest,
): Promise<OnboardingCompleteResponse> {
  return postJson<OnboardingCompleteResponse>(apiOnboardingCompletePath(), body);
}
