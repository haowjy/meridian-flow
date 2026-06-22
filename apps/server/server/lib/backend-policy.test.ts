import { describe, expect, it } from "vitest";
import { resolveBackends, resolveBackendTier, resolveProvider } from "./backend-policy.js";

describe("resolveBackendTier", () => {
  it("defaults to local when the umbrella is unset", () => {
    expect(resolveBackendTier(undefined)).toBe("local");
  });
});

describe("resolveProvider", () => {
  it("uses the explicit override when set", () => {
    expect(
      resolveProvider({
        override: "noop",
        backends: "live",
        local: "local",
        live: "noop",
      }),
    ).toBe("noop");
  });

  it("uses the local default when override is unset and backends is local", () => {
    expect(
      resolveProvider({
        override: undefined,
        backends: "local",
        local: "local",
        live: "cloud",
      }),
    ).toBe("local");
  });

  it("uses the live default when override is unset and backends is live", () => {
    expect(
      resolveProvider({
        override: undefined,
        backends: "live",
        local: "local",
        live: "s3",
      }),
    ).toBe("s3");
  });
});

describe("resolveBackends", () => {
  it("resolves local defaults when the umbrella is unset", () => {
    expect(resolveBackends({})).toEqual({
      backends: "local",
      objectStore: "local",
      event: "local",
    });
  });

  it("resolves live defaults for retained provider seams", () => {
    expect(resolveBackends({ MERIDIAN_BACKENDS: "live" })).toEqual({
      backends: "live",
      objectStore: "s3",
      event: "local",
    });
  });

  it.each([
    ["OBJECT_STORE_PROVIDER", "s3", "objectStore", "s3"],
    ["EVENT_PROVIDER", "noop", "event", "noop"],
  ] as const)("per-service override %s wins over umbrella", (overrideKey, overrideValue, resolvedKey, expected) => {
    const resolved = resolveBackends({
      MERIDIAN_BACKENDS: "local",
      [overrideKey]: overrideValue,
    });
    expect(resolved[resolvedKey]).toBe(expected);
  });
});
