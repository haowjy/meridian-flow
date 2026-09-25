/**
 * Startup guards: pure config validation plus the boot-time assertion wrapper.
 * The checks fail fast for missing persistence, cloud object storage without
 * credentials, and production auth placeholders.
 */

import { assertSupportedDatabaseUrl } from "@meridian/database";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import type { ObjectStoreProvider } from "./backend-policy.js";

const DEFAULT_DEV_SECRETS = new Set(["", "dev-workos-key", "dev-workos-client"]);
const WORKOS_TEST_API_KEY_PATTERN = /^sk_test_/i;

const PLACEHOLDER_SECRET_PATTERNS: Partial<Record<keyof ApiStartupEnv, RegExp[]>> = {
  WORKOS_CLIENT_ID: [/^client_\.\.\.$/i, /^client_ci/i],
};

type StartupGuardOutcome = {
  errors: string[];
  warnings: string[];
  replicaCount: number | null;
  durableEventBackend: string;
};

export type ApiStartupEnv = {
  NODE_ENV: "development" | "test" | "production";
  APP_ENV: "dev" | "staging" | "production";
  DATABASE_URL?: string;
  OBJECT_STORE_PROVIDER: ObjectStoreProvider;
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  S3_PUBLIC_ENDPOINT?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  MODEL_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_COOKIE_PASSWORD?: string;
  WORKOS_REDIRECT_URI?: string;
  WORKOS_DEV_AUTOLOGIN?: string;
  WORKOS_DEV_LOGIN_EMAIL?: string;
  WORKOS_DEV_LOGIN_PASSWORD?: string;
  MERIDIAN_BACKENDS?: "local" | "live";
  API_REPLICA_COUNT?: number;
  DURABLE_EVENT_BACKEND: string;
};

function hasValue(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRealSecret(
  key: keyof ApiStartupEnv,
  value: string | undefined | null,
  options: { allowWorkosTestApiKey?: boolean } = {},
): boolean {
  if (!hasValue(value)) return false;
  const trimmed = value.trim();
  if (DEFAULT_DEV_SECRETS.has(trimmed)) return false;
  if (
    key === "WORKOS_API_KEY" &&
    !options.allowWorkosTestApiKey &&
    WORKOS_TEST_API_KEY_PATTERN.test(trimmed)
  ) {
    return false;
  }
  return !(PLACEHOLDER_SECRET_PATTERNS[key] ?? []).some((pattern) => pattern.test(trimmed));
}

function requireValue(
  errors: string[],
  key: string,
  value: string | undefined,
  reason: string,
): void {
  if (!hasValue(value)) errors.push(`${key}: ${reason}`);
}

function requireRealSecret(
  errors: string[],
  key: keyof ApiStartupEnv,
  value: string | undefined,
  reason: string,
  options?: { allowWorkosTestApiKey?: boolean },
): void {
  if (!isRealSecret(key, value, options)) errors.push(`${key}: ${reason}`);
}

function isLocalUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function evaluateApiStartupGuards(config: ApiStartupEnv): StartupGuardOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isLiveEnvironment = config.APP_ENV === "staging" || config.APP_ENV === "production";
  const isProduction = config.NODE_ENV === "production";
  const allowWorkosTestApiKey = config.APP_ENV === "staging";

  requireValue(errors, "DATABASE_URL", config.DATABASE_URL, "required for persistence.");
  if (hasValue(config.DATABASE_URL)) {
    try {
      assertSupportedDatabaseUrl(config.DATABASE_URL, config.APP_ENV);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (config.OBJECT_STORE_PROVIDER === "s3") {
    requireValue(
      errors,
      "S3_ACCESS_KEY",
      config.S3_ACCESS_KEY,
      "required when OBJECT_STORE_PROVIDER=s3.",
    );
    requireValue(
      errors,
      "S3_SECRET_KEY",
      config.S3_SECRET_KEY,
      "required when OBJECT_STORE_PROVIDER=s3.",
    );
  }

  if (isLiveEnvironment) {
    if (config.MERIDIAN_BACKENDS !== "live") {
      errors.push("MERIDIAN_BACKENDS: must be explicitly set to live in staging/production.");
    }
    if (config.OBJECT_STORE_PROVIDER !== "s3") {
      errors.push("OBJECT_STORE_PROVIDER: must be s3 in staging/production.");
    }
    requireValue(errors, "S3_BUCKET", config.S3_BUCKET, "required for live object storage.");
    if (isLocalUrl(config.S3_ENDPOINT)) {
      errors.push("S3_ENDPOINT: localhost endpoints are not allowed in staging/production.");
    }
    if (isLocalUrl(config.S3_PUBLIC_ENDPOINT)) {
      errors.push("S3_PUBLIC_ENDPOINT: localhost endpoints are not allowed in staging/production.");
    }
    if (isLocalUrl(config.DATABASE_URL)) {
      errors.push("DATABASE_URL: localhost URLs are not allowed in staging/production.");
    }
    if (isLocalUrl(config.WORKOS_REDIRECT_URI)) {
      errors.push("WORKOS_REDIRECT_URI: localhost URLs are not allowed in staging/production.");
    }
    if (
      config.WORKOS_DEV_AUTOLOGIN === "1" ||
      config.WORKOS_DEV_LOGIN_EMAIL ||
      config.WORKOS_DEV_LOGIN_PASSWORD
    ) {
      errors.push(
        "WORKOS_DEV_*: development login settings are not allowed in staging/production.",
      );
    }
    if (config.MODEL_PROVIDER === "mock") {
      errors.push("MODEL_PROVIDER: mock is not allowed in staging/production.");
    }
    if (
      ![
        config.ANTHROPIC_API_KEY,
        config.OPENAI_API_KEY,
        config.DEEPSEEK_API_KEY,
        config.OPENROUTER_API_KEY,
      ].some(isRealProviderKey)
    ) {
      errors.push("MODEL_PROVIDER: at least one live provider API key is required.");
    }
    requireRealSecret(
      errors,
      "WORKOS_API_KEY",
      config.WORKOS_API_KEY,
      "must be set to a real WorkOS API key in production.",
      { allowWorkosTestApiKey },
    );
    requireRealSecret(
      errors,
      "WORKOS_CLIENT_ID",
      config.WORKOS_CLIENT_ID,
      "must be set to a real WorkOS client id in production.",
    );
    requireValue(
      errors,
      "WORKOS_COOKIE_PASSWORD",
      config.WORKOS_COOKIE_PASSWORD,
      "required for sealed session cookies in production.",
    );
    if (config.WORKOS_COOKIE_PASSWORD && config.WORKOS_COOKIE_PASSWORD.length < 32) {
      errors.push("WORKOS_COOKIE_PASSWORD: must be at least 32 characters in staging/production.");
    }
  }

  const replicaCount = config.API_REPLICA_COUNT ?? null;
  const durableEventBackend = config.DURABLE_EVENT_BACKEND;

  if (isLiveEnvironment && replicaCount !== 1) {
    errors.push("API_REPLICA_COUNT: must be explicitly set to 1 in staging/production.");
  }

  if (isProduction && replicaCount === null) {
    warnings.push(
      "API_REPLICA_COUNT is unset in production; single-replica enforcement is advisory until deployment metadata is provided.",
    );
  }

  if (replicaCount !== null && replicaCount > 1 && durableEventBackend === "none") {
    const message =
      "API_REPLICA_COUNT > 1 requires durable event/log coordination; current mode is DURABLE_EVENT_BACKEND=none.";
    if (isProduction) errors.push(message);
    else warnings.push(message);
  }

  return { errors, warnings, replicaCount, durableEventBackend };
}

function isRealProviderKey(key: string | undefined): boolean {
  return Boolean(key?.trim() && !key.trim().startsWith("dev-"));
}

export async function assertApiStartupGuards(): Promise<StartupGuardOutcome> {
  const { env } = await import("./env.js");
  const { resolveBackends } = await import("./backend-policy.js");
  const backends = resolveBackends(process.env);

  const outcome = evaluateApiStartupGuards({
    NODE_ENV: env.NODE_ENV,
    APP_ENV: env.APP_ENV,
    DATABASE_URL: env.DATABASE_URL,
    OBJECT_STORE_PROVIDER: backends.objectStore,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
    MODEL_PROVIDER: process.env.MODEL_PROVIDER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    WORKOS_API_KEY: env.WORKOS_API_KEY,
    WORKOS_CLIENT_ID: env.WORKOS_CLIENT_ID,
    WORKOS_COOKIE_PASSWORD: env.WORKOS_COOKIE_PASSWORD,
    WORKOS_REDIRECT_URI: env.WORKOS_REDIRECT_URI,
    WORKOS_DEV_AUTOLOGIN: env.WORKOS_DEV_AUTOLOGIN,
    WORKOS_DEV_LOGIN_EMAIL: env.WORKOS_DEV_LOGIN_EMAIL,
    WORKOS_DEV_LOGIN_PASSWORD: env.WORKOS_DEV_LOGIN_PASSWORD,
    MERIDIAN_BACKENDS: process.env.MERIDIAN_BACKENDS as "local" | "live" | undefined,
    API_REPLICA_COUNT: process.env.API_REPLICA_COUNT
      ? Number(process.env.API_REPLICA_COUNT)
      : undefined,
    DURABLE_EVENT_BACKEND: process.env.DURABLE_EVENT_BACKEND ?? "none",
  });
  if (outcome.errors.length > 0) {
    const details = outcome.errors.map((error) => `  - ${error}`).join("\n");
    throw new Error(`Invalid API startup configuration:\n${details}`);
  }
  return outcome;
}

export async function exitOnStartupGuardFailure(
  error: unknown,
  options: { eventSink: EventSink; exit?: (code: number) => void },
): Promise<void> {
  emitEvent(options.eventSink, {
    level: "error",
    source: "plugins.startup",
    name: "startup_guard.failed",
    payload: {
      message: error instanceof Error ? error.message : String(error),
      ...unknownToEventPayload(error),
    },
  });
  try {
    await options.eventSink.flush();
  } catch (flushError) {
    process.stderr.write(`startup_guard.event_flush_failed ${String(flushError)}\n`);
  }
  (options.exit ?? ((code) => process.exit(code)))(1);
}
