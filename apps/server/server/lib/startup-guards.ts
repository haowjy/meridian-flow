/**
 * Startup guards: pure config validation plus the boot-time assertion wrapper.
 * The checks fail fast for missing persistence, live model routing without real
 * provider keys, cloud object storage without credentials, and production auth
 * placeholders.
 */
import type { BackendTier, ModelProvider, ObjectStoreProvider } from "./backend-policy.js";

const DEFAULT_DEV_SECRETS = new Set([
  "",
  "dev-openai-key",
  "dev-supabase-url",
  "dev-supabase-anon-key",
]);

const PLACEHOLDER_SECRET_PATTERNS: Partial<Record<keyof ApiStartupEnv, RegExp[]>> = {
  SUPABASE_URL: [/localhost/i, /127\.0\.0\.1/],
  SUPABASE_ANON_KEY: [/^ey-dev-/i],
};

type StartupGuardOutcome = {
  errors: string[];
  warnings: string[];
  replicaCount: number | null;
  durableEventBackend: string;
};

export type ApiStartupEnv = {
  NODE_ENV: "development" | "test" | "production";
  DATABASE_URL?: string;
  MODEL_PROVIDER: ModelProvider;
  backends: BackendTier;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OBJECT_STORE_PROVIDER: ObjectStoreProvider;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  API_REPLICA_COUNT?: number;
  DURABLE_EVENT_BACKEND: string;
};

function hasValue(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRealSecret(key: keyof ApiStartupEnv, value: string | undefined | null): boolean {
  if (!hasValue(value)) return false;
  const trimmed = value.trim();
  if (DEFAULT_DEV_SECRETS.has(trimmed)) return false;
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
): void {
  if (!isRealSecret(key, value)) errors.push(`${key}: ${reason}`);
}

export function evaluateApiStartupGuards(config: ApiStartupEnv): StartupGuardOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = config.NODE_ENV === "production";

  requireValue(errors, "DATABASE_URL", config.DATABASE_URL, "required for persistence.");

  const hasRealAnthropicKey = isRealSecret("ANTHROPIC_API_KEY", config.ANTHROPIC_API_KEY);
  const hasRealOpenAiKey = isRealSecret("OPENAI_API_KEY", config.OPENAI_API_KEY);
  const hasRealDeepseekKey = isRealSecret("DEEPSEEK_API_KEY", config.DEEPSEEK_API_KEY);
  if (config.MODEL_PROVIDER === "anthropic" && !hasRealAnthropicKey) {
    errors.push(
      "ANTHROPIC_API_KEY: required and must be non-placeholder when MODEL_PROVIDER=anthropic.",
    );
  }
  if (config.MODEL_PROVIDER === "openai" && !hasRealOpenAiKey) {
    errors.push("OPENAI_API_KEY: required and must be non-placeholder when MODEL_PROVIDER=openai.");
  }
  if (
    config.backends === "live" &&
    config.MODEL_PROVIDER === "auto" &&
    !hasRealAnthropicKey &&
    !hasRealOpenAiKey &&
    !hasRealDeepseekKey
  ) {
    errors.push(
      "MODEL_PROVIDER=auto requires at least one real provider key in live mode " +
        "(ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY).",
    );
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

  if (isProduction) {
    requireRealSecret(
      errors,
      "SUPABASE_URL",
      config.SUPABASE_URL,
      "must be set to a production Supabase URL.",
    );
    requireRealSecret(
      errors,
      "SUPABASE_ANON_KEY",
      config.SUPABASE_ANON_KEY,
      "must be set to a production Supabase anon key.",
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
    DATABASE_URL: env.DATABASE_URL,
    MODEL_PROVIDER: backends.model,
    backends: backends.backends,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    OBJECT_STORE_PROVIDER: backends.objectStore,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
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
