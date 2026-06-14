import { describe, expect, it, vi } from "vitest";
import { shouldRedirectToOnboarding } from "./onboarding-gate";

vi.mock("@/client/api/onboarding-api", () => ({
  getOnboardingStatus: vi.fn(),
}));

vi.mock("./ssr-request", () => ({
  requestFromServerHeaders: vi.fn(),
}));

vi.mock("@/client/api/ssr-api-request", () => ({
  ssrApiRequestInitFromRequest: vi.fn(),
}));

import { getOnboardingStatus } from "@/client/api/onboarding-api";
import { ssrApiRequestInitFromRequest } from "@/client/api/ssr-api-request";
import { resolveOnboardingGate } from "./onboarding-gate";
import { requestFromServerHeaders } from "./ssr-request";

describe("shouldRedirectToOnboarding", () => {
  it("redirects gated authenticated routes except onboarding itself", () => {
    expect(shouldRedirectToOnboarding({ shouldOnboard: true }, "/")).toBe(true);
    expect(shouldRedirectToOnboarding({ shouldOnboard: true }, "/projects")).toBe(true);
    expect(shouldRedirectToOnboarding({ shouldOnboard: true }, "/onboarding")).toBe(false);
    expect(shouldRedirectToOnboarding({ shouldOnboard: false }, "/")).toBe(false);
  });
});

describe("resolveOnboardingGate", () => {
  it("returns fetch_failed when the onboarding status request throws", async () => {
    vi.mocked(requestFromServerHeaders).mockReturnValue(
      new Request("https://app.meridian.localhost/"),
    );
    vi.mocked(ssrApiRequestInitFromRequest).mockReturnValue({
      origin: "https://server.meridian.localhost",
      headers: { cookie: "session=abc" },
    });
    vi.mocked(getOnboardingStatus).mockRejectedValue(new Error("ERR_INVALID_URL"));

    await expect(resolveOnboardingGate()).resolves.toEqual({ ok: false, reason: "fetch_failed" });
  });

  it("returns missing_origin when SSR API origin cannot be resolved", async () => {
    vi.mocked(requestFromServerHeaders).mockReturnValue(
      new Request("https://app.meridian.localhost/"),
    );
    vi.mocked(ssrApiRequestInitFromRequest).mockReturnValue({ headers: { cookie: "session=abc" } });

    await expect(resolveOnboardingGate()).resolves.toEqual({ ok: false, reason: "missing_origin" });
  });

  it("returns onboarding status when SSR fetch succeeds", async () => {
    const status = {
      state: { status: "in_progress" as const },
      projectCount: 0,
      shouldOnboard: true,
    };
    vi.mocked(requestFromServerHeaders).mockReturnValue(
      new Request("https://app.meridian.localhost/"),
    );
    vi.mocked(ssrApiRequestInitFromRequest).mockReturnValue({
      origin: "https://server.meridian.localhost",
    });
    vi.mocked(getOnboardingStatus).mockResolvedValue(status);

    await expect(resolveOnboardingGate()).resolves.toEqual({ ok: true, status });
  });

  it("falls back to browser-relative fetch when route loaders run on client navigation", async () => {
    const status = {
      state: {},
      projectCount: 0,
      shouldOnboard: true,
    };
    vi.stubGlobal("window", {});
    vi.mocked(requestFromServerHeaders).mockImplementation(() => {
      throw new Error("server headers unavailable");
    });
    vi.mocked(getOnboardingStatus).mockResolvedValue(status);

    await expect(resolveOnboardingGate()).resolves.toEqual({ ok: true, status });
    expect(getOnboardingStatus).toHaveBeenCalledWith(undefined);

    vi.unstubAllGlobals();
  });
});
