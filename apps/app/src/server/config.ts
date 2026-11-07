/** App server config: runtime config plus the WorkOS redirect URI fallback. */
import { readOptionalEnvString } from "@/core/env";
import { parseRuntimeConfig, type RuntimeConfig } from "./runtime-config";

export type AppServerConfig = {
  runtime: RuntimeConfig;
  workosRedirectUri: string | null;
};

export function parseAppServerConfig(env: NodeJS.ProcessEnv): AppServerConfig {
  return {
    runtime: parseRuntimeConfig(env),
    workosRedirectUri: readOptionalEnvString(env.WORKOS_REDIRECT_URI) ?? null,
  };
}

let cachedConfig: AppServerConfig | null = null;

export function getAppServerConfig(): AppServerConfig {
  if (!cachedConfig) cachedConfig = parseAppServerConfig(process.env);
  return cachedConfig;
}
