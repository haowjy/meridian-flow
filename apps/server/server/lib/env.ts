import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ENV: z.enum(["dev", "staging", "production"]).default("dev"),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1).optional(),

    WORKOS_API_KEY: z.string().default("dev-workos-key"),
    WORKOS_CLIENT_ID: z.string().default("dev-workos-client"),
    WORKOS_COOKIE_PASSWORD: z.string().default(""),
    WORKOS_REDIRECT_URI: z.string().url().optional(),
    WORKOS_DEV_LOGIN_EMAIL: z.string().optional(),
    WORKOS_DEV_LOGIN_PASSWORD: z.string().optional(),
    WORKOS_DEV_AUTOLOGIN: z.enum(["0", "1"]).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export const modelRequestDebugCaptureEnabled = resolveModelRequestDebugCaptureEnabled({
  rawNodeEnv: process.env.NODE_ENV,
  rawAppEnv: env.APP_ENV,
  debugCaptureOverride: process.env.MODEL_REQUEST_DEBUG_CAPTURE,
});

export const recentEventsEnabled = resolveRecentEventsEnabled({
  rawNodeEnv: process.env.NODE_ENV,
});

/**
 * Fail-safe model-request debug capture gate.
 *
 * Capture is structurally unavailable outside local development/test.
 * MODEL_REQUEST_DEBUG_CAPTURE can disable it locally but cannot enable it in
 * staging or production.
 */
export function resolveModelRequestDebugCaptureEnabled(input: {
  rawNodeEnv?: string;
  rawAppEnv?: string;
  debugCaptureOverride?: string;
}): boolean {
  if (
    (input.rawNodeEnv !== "development" && input.rawNodeEnv !== "test") ||
    input.rawAppEnv !== "dev"
  ) {
    return false;
  }
  if (input.debugCaptureOverride === "0" || input.debugCaptureOverride === "false") return false;
  return true;
}

/** Recent-event consumption is structurally unavailable outside local test/dev processes. */
export function resolveRecentEventsEnabled(input: { rawNodeEnv?: string }): boolean {
  return input.rawNodeEnv === "development" || input.rawNodeEnv === "test";
}

/** Verbose observability is an explicit opt-in that cannot be enabled in production. */
export function resolveObsVerbose(input: {
  rawNodeEnv?: string;
  obsVerbose?: string;
}): ReadonlySet<string> {
  if (input.rawNodeEnv !== "development" && input.rawNodeEnv !== "test") return new Set();

  const knownCategories = new Set(["gateway.chunks"]);
  return new Set(
    input.obsVerbose
      ?.split(",")
      .map((category) => category.trim())
      .filter((category) => knownCategories.has(category)) ?? [],
  );
}
