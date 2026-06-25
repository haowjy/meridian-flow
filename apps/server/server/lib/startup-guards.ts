/**
 * Startup guards: pure config validation plus the boot-time assertion wrapper.
 * The checks fail fast for missing persistence, cloud object storage without
 * credentials, and production auth placeholders.
 */
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
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_COOKIE_PASSWORD?: string;
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

export function evaluateApiStartupGuards(config: ApiStartupEnv): StartupGuardOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = config.NODE_ENV === "production";
  const allowWorkosTestApiKey = config.APP_ENV === "staging";

  requireValue(errors, "DATABASE_URL", config.DATABASE_URL, "required for persistence.");

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

  if (isProduction) {
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
  }

  const replicaCount = config.API_REPLICA_COUNT ?? null;
  const durableEventBackend = config.DURABLE_EVENT_BACKEND;

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

export async function assertApiStartupGuards(): Promise<StartupGuardOutcome> {
  const { env } = await import("./env.js");
  const { resolveBackends } = await import("./backend-policy.js");
  const backends = resolveBackends(process.env);

  const outcome = evaluateApiStartupGuards({
    NODE_ENV: env.NODE_ENV,
    APP_ENV: env.APP_ENV,
    DATABASE_URL: env.DATABASE_URL,
    OBJECT_STORE_PROVIDER: backends.objectStore,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
    WORKOS_API_KEY: env.WORKOS_API_KEY,
    WORKOS_CLIENT_ID: env.WORKOS_CLIENT_ID,
    WORKOS_COOKIE_PASSWORD: env.WORKOS_COOKIE_PASSWORD,
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
