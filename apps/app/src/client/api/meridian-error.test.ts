import { describe, expect, it } from "vitest";

import {
  isMeridianApiError,
  MeridianApiError,
  meridianApiErrorFromPayload,
} from "./meridian-error";

describe("MeridianApiError", () => {
  it("carries envelope fields and is detectable as a structured error", () => {
    const error = new MeridianApiError({
      code: "rate_limited",
      message: "Slow down",
      retryable: true,
      source: "gateway",
      details: { remaining: 0 },
    });

    expect(error.message).toBe("Slow down");
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.source).toBe("gateway");
    expect(error.details).toEqual({ remaining: 0 });
    expect(isMeridianApiError(error)).toBe(true);
    expect(error instanceof Error).toBe(true);
  });
});

describe("meridianApiErrorFromPayload", () => {
  it("parses the bare envelope shape", () => {
    const parsed = meridianApiErrorFromPayload({
      code: "auth_failed",
      message: "Unauthorized",
      retryable: false,
      source: "system",
    });
    expect(parsed?.code).toBe("auth_failed");
    expect(parsed?.message).toBe("Unauthorized");
  });

  it("parses the wrapped interrupt body shape", () => {
    const parsed = meridianApiErrorFromPayload({
      kind: "error",
      error: {
        code: "internal",
        message: "boom",
        retryable: false,
        source: "system",
      },
    });
    expect(parsed?.code).toBe("internal");
    expect(parsed?.source).toBe("system");
  });

  it("returns null when the payload is not a MeridianError", () => {
    expect(meridianApiErrorFromPayload(null)).toBeNull();
    expect(meridianApiErrorFromPayload({ message: "no code field" })).toBeNull();
    expect(meridianApiErrorFromPayload("text")).toBeNull();
  });
});
