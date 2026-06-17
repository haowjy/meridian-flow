/**
 * runtime-config — parses the app server runtime environment into a typed shape.
 *
 * This mirrors the upstream app-server config seam while keeping provider choice
 * out of runtime parsing. Auth/database specifics live in server adapters.
 */
export const APP_ENV_VALUES = ["dev", "staging", "production"] as const;
export const LOG_LEVEL_VALUES = ["debug", "info", "warn", "error"] as const;

export type AppEnv = (typeof APP_ENV_VALUES)[number];
export type LogLevel = (typeof LOG_LEVEL_VALUES)[number];

export type RuntimeConfig = {
  appEnv: AppEnv;
  logLevel: LogLevel;
};

export type RuntimeConfigEnv = Record<string, string | undefined>;

export class RuntimeConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid runtime configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "RuntimeConfigError";
    this.issues = issues;
  }
}

function parseEnumValue<T extends string>(env: RuntimeConfigEnv, key: string): T | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  return raw as T;
}

function ensureEnumValue<T extends string>(
  issues: string[],
  key: string,
  value: T | undefined,
  allowed: readonly T[],
): T | undefined {
  if (!value) return undefined;
  if (allowed.includes(value)) return value;
  issues.push(`${key} must be one of: ${allowed.join("|")}. Received: ${value}`);
  return undefined;
}

function defaultLogLevel(appEnv: AppEnv): LogLevel {
  return appEnv === "dev" ? "debug" : "info";
}

export function parseRuntimeConfig(env: RuntimeConfigEnv): RuntimeConfig {
  const issues: string[] = [];
  const appEnvFromEnv = parseEnumValue<AppEnv>(env, "APP_ENV");
  const appEnv =
    ensureEnumValue(issues, "APP_ENV", appEnvFromEnv, APP_ENV_VALUES) ?? ("dev" satisfies AppEnv);
  const logLevelFromEnv = parseEnumValue<LogLevel>(env, "LOG_LEVEL");
  const logLevel =
    ensureEnumValue(issues, "LOG_LEVEL", logLevelFromEnv, LOG_LEVEL_VALUES) ??
    defaultLogLevel(appEnv);
  if (issues.length > 0) throw new RuntimeConfigError(issues);
  return { appEnv, logLevel };
}
