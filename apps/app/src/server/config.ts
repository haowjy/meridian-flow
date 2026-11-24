import { readOptionalEnvString } from "@/core/env";
import { parseRuntimeConfig, type RuntimeConfig } from "./runtime-config";

export type AppServerConfig = {
  runtime: RuntimeConfig;
  workosRedirectUri: string | null;
  landingUrl: string | null;
};

export function parseAppServerConfig(env: NodeJS.ProcessEnv): AppServerConfig {
  return {
    runtime: parseRuntimeConfig(env),
    workosRedirectUri: readOptionalEnvString(env.WORKOS_REDIRECT_URI) ?? null,
    landingUrl: readOptionalEnvString(env.MERIDIAN_WWW_ORIGIN) ?? null,
  };
}

let cachedConfig: AppServerConfig | null = null;

export function getAppServerConfig(): AppServerConfig {
  if (!cachedConfig) cachedConfig = parseAppServerConfig(process.env);
  return cachedConfig;
}
