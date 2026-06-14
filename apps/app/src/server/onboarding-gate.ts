import type { OnboardingStatusResponse } from "@meridian/contracts/protocol";
import { getOnboardingStatus } from "@/client/api/onboarding-api";
import { ssrApiRequestInitFromRequest } from "@/client/api/ssr-api-request";
import { requestFromServerHeaders } from "./ssr-request";

export function shouldRedirectToOnboarding(
  status: Pick<OnboardingStatusResponse, "shouldOnboard">,
  pathname: string,
): boolean {
  return status.shouldOnboard && pathname !== "/onboarding";
}

export type OnboardingGateResult =
  | { ok: true; status: OnboardingStatusResponse }
  | { ok: false; reason: "missing_origin" | "fetch_failed" };

function ssrApiRequestInitForGate() {
  if (typeof window !== "undefined") return undefined;
  const request = requestFromServerHeaders();
  if (!request) return undefined;
  return ssrApiRequestInitFromRequest(request);
}

export async function resolveOnboardingGate(): Promise<OnboardingGateResult> {
  try {
    const init = ssrApiRequestInitForGate();
    if (!init?.origin && typeof window === "undefined") {
      console.error("Onboarding gate: missing SSR API origin");
      return { ok: false, reason: "missing_origin" };
    }
    const status = await getOnboardingStatus(init);
    return { ok: true, status };
  } catch (error) {
    console.error("Failed to load onboarding gate during SSR:", error);
    return { ok: false, reason: "fetch_failed" };
  }
}

/** @deprecated Use resolveOnboardingGate — kept for callers expecting nullable status. */
export async function loadOnboardingGate(): Promise<OnboardingStatusResponse | null> {
  const gate = await resolveOnboardingGate();
  return gate.ok ? gate.status : null;
}
