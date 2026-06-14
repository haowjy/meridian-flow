import { createFileRoute } from "@tanstack/react-router";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";

export const Route = createFileRoute("/_authenticated/onboarding")({
  component: OnboardingFlow,
});
