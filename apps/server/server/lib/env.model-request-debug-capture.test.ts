// @ts-nocheck
/**
 * Truth table for the fail-safe model-request debug capture gate.
 */
import { describe, expect, it } from "vitest";
import { resolveModelRequestDebugCaptureEnabled } from "./env.js";

function gate(rawNodeEnv: string | undefined, debugCaptureOverride?: string): boolean {
  return resolveModelRequestDebugCaptureEnabled({
    rawNodeEnv,
    debugCaptureOverride,
  });
}

describe("resolveModelRequestDebugCaptureEnabled", () => {
  it("is off when NODE_ENV is unset", () => {
    expect(gate(undefined)).toBe(false);
  });

  it("is on when NODE_ENV is development", () => {
    expect(gate("development")).toBe(true);
  });

  it("is on when NODE_ENV is test", () => {
    expect(gate("test")).toBe(true);
  });

  it("is off when NODE_ENV is production", () => {
    expect(gate("production")).toBe(false);
  });

  it("is on when NODE_ENV is production and MODEL_REQUEST_DEBUG_CAPTURE=1", () => {
    expect(gate("production", "1")).toBe(true);
  });

  it("is off when NODE_ENV is development and MODEL_REQUEST_DEBUG_CAPTURE=0", () => {
    expect(gate("development", "0")).toBe(false);
  });

  it("is off for unknown NODE_ENV values", () => {
    expect(gate("staging")).toBe(false);
  });
});
