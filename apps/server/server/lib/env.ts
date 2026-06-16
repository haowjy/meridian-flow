import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export const modelRequestDebugCaptureEnabled = resolveModelRequestDebugCaptureEnabled({
  rawNodeEnv: process.env.NODE_ENV,
  debugCaptureOverride: process.env.MODEL_REQUEST_DEBUG_CAPTURE,
});

/**
 * Fail-safe model-request debug capture gate.
 *
 * Development/test capture by default; production requires an explicit
 * MODEL_REQUEST_DEBUG_CAPTURE opt-in. "0" always disables.
 */
export function resolveModelRequestDebugCaptureEnabled(input: {
  rawNodeEnv?: string;
  debugCaptureOverride?: string;
}): boolean {
  if (input.debugCaptureOverride === "1" || input.debugCaptureOverride === "true") return true;
  if (input.debugCaptureOverride === "0" || input.debugCaptureOverride === "false") return false;
  if (input.rawNodeEnv === "development" || input.rawNodeEnv === "test") return true;
  return false;
}
