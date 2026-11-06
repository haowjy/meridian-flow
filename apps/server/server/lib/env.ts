import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { isProductionEnv } from "./production-env.js";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ENV: z.enum(["dev", "staging", "production"]).default("dev"),
    /** Explicit opt-in for debug paths; see `resolveDebugPathsEnabled`. */
    APP_DEBUG: z.enum(["0", "1", "true", "false"]).optional(),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1).optional(),

    WORKOS_API_KEY: z.string().default("dev-workos-key"),
    WORKOS_CLIENT_ID: z.string().default("dev-workos-client"),
    WORKOS_COOKIE_PASSWORD: z.string().default(""),
    WORKOS_REDIRECT_URI: z.string().url().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

/**
 * The one gate for every debug path: model-request capture, recent events
 * (`/api/debug/events`), debug routes, and the mock-model script queue.
 *
 * Never on in production (`isProductionEnv`), even with the flag. Everywhere else (dev, test, staging) debug
 * paths are on only with an explicit `APP_DEBUG=1`; `pnpm dev` sets it.
 */
export function resolveDebugPathsEnabled(input: {
  rawNodeEnv?: string;
  rawAppEnv?: string;
  debugFlag?: string;
}): boolean {
  if (isProductionEnv(input)) return false;
  return input.debugFlag === "1" || input.debugFlag === "true";
}

export const debugPathsEnabled = resolveDebugPathsEnabled({
  rawNodeEnv: process.env.NODE_ENV,
  rawAppEnv: process.env.APP_ENV,
  debugFlag: process.env.APP_DEBUG,
});

/** Wake-sweep cadence; the recovery may also run on process startup. */
export function resolveWakeSweepIntervalMs(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
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
