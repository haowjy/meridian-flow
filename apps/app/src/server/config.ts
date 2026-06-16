/** App server config: runtime config plus WorkOS/dev-login/API origin settings. */
import { parseRuntimeConfig, type RuntimeConfig } from "./runtime-config";

export type AppServerConfig = {
  runtime: RuntimeConfig;
  isProduction: boolean;
  devAutologin: boolean;
  workosClientId: string | null;
  workosRedirectUri: string | null;
  workosDevLogin: { email: string; password: string } | null;
  apiOrigin: string | null;
};

function readOptionalTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseWorkosDevLogin(env: NodeJS.ProcessEnv): { email: string; password: string } | null {
  const email = readOptionalTrimmed(env.WORKOS_DEV_LOGIN_EMAIL);
  const password = readOptionalTrimmed(env.WORKOS_DEV_LOGIN_PASSWORD);
  if (!email || !password) return null;
  return { email, password };
}

export function parseAppServerConfig(env: NodeJS.ProcessEnv): AppServerConfig {
  const isProduction = env.NODE_ENV === "production";
  const workosDevLogin = parseWorkosDevLogin(env);
  return {
    runtime: parseRuntimeConfig(env),
    isProduction,
    devAutologin: !isProduction && env.WORKOS_DEV_AUTOLOGIN === "1" && workosDevLogin !== null,
    workosClientId: readOptionalTrimmed(env.WORKOS_CLIENT_ID),
    workosRedirectUri: readOptionalTrimmed(env.WORKOS_REDIRECT_URI),
    workosDevLogin,
    apiOrigin: readOptionalTrimmed(env.MERIDIAN_API_ORIGIN),
  };
}

let cachedConfig: AppServerConfig | null = null;

export function getAppServerConfig(): AppServerConfig {
  if (!cachedConfig) cachedConfig = parseAppServerConfig(process.env);
  return cachedConfig;
}

export function getAppRuntimeConfig(): RuntimeConfig {
  return getAppServerConfig().runtime;
}

export function resetAppServerConfigForTests(): void {
  cachedConfig = null;
}
