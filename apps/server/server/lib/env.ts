import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export function assertProductionAppEnvPresent(input: {
  rawNodeEnv?: string;
  rawAppEnv?: string;
}): void {
  if (input.rawNodeEnv === "production" && !input.rawAppEnv?.trim()) {
    throw new Error("APP_ENV must be set to staging or production when NODE_ENV=production.");
  }
}

assertProductionAppEnvPresent({
  rawNodeEnv: process.env.NODE_ENV,
  rawAppEnv: process.env.APP_ENV,
});

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
    WORKOS_DEV_LOGIN_EMAIL: z.string().optional(),
    WORKOS_DEV_LOGIN_PASSWORD: z.string().optional(),
    WORKOS_DEV_AUTOLOGIN: z.enum(["0", "1"]).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

/**
 * The one gate for every debug path: model-request capture, recent events
 * (`/api/debug/events`), debug routes, and the mock-model script queue.
 *
 * Never on in production, even with the flag. `NODE_ENV=production` with
 * `APP_ENV` unset or `dev` also counts as production, so a deployed process
 * missing `APP_ENV` fails closed. Everywhere else (dev, test, staging) debug
 * paths are on only with an explicit `APP_DEBUG=1`; `pnpm dev` sets it.
 */
export function resolveDebugPathsEnabled(input: {
  rawNodeEnv?: string;
  rawAppEnv?: string;
  debugFlag?: string;
}): boolean {
  const appEnv = input.rawAppEnv ?? "dev";
  if (appEnv === "production") return false;
  if (input.rawNodeEnv === "production" && appEnv === "dev") return false;
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
