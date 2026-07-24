/** Dev app environment allowlist coverage for runtime diagnostic controls. */
import { describe, expect, it } from "vitest";
import { resolveAppEnvPassthroughKeys } from "./dev-app-env-passthrough";

describe("resolveAppEnvPassthroughKeys", () => {
  it("forwards the gateway verbose observability selector when present", () => {
    expect(resolveAppEnvPassthroughKeys({ OBS_VERBOSE: "gateway.chunks" })).toEqual([
      "OBS_VERBOSE",
    ]);
  });
});
