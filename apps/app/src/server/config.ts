/** App server config: runtime config plus Supabase/dev-login/API origin settings. */
import { parseRuntimeConfig, type RuntimeConfig } from "./runtime-config";

export type AppServerConfig = {
  runtime: RuntimeConfig;
  isProduction: boolean;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  supabaseAuthRedirectUri: string | null;
  devLogin: { email: string; password: string } | null;
  devAutologin: boolean;
  apiOrigin: string | null;
};

function readOptionalTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseDevLogin(env: NodeJS.ProcessEnv): { email: string; password: string } | null {
  const email = readOptionalTrimmed(env.TEST_USER_EMAIL);
  const password = readOptionalTrimmed(env.TEST_USER_PASSWORD);
  if (!email || !password) return null;
  return { email, password };
}

export function parseAppServerConfig(env: NodeJS.ProcessEnv): AppServerConfig {
  const isProduction = env.NODE_ENV === "production";
  const devLogin = parseDevLogin(env);
  return {
    runtime: parseRuntimeConfig(env),
    isProduction,
    supabaseUrl: readOptionalTrimmed(env.SUPABASE_URL),
    supabaseAnonKey: readOptionalTrimmed(env.SUPABASE_ANON_KEY),
    supabaseAuthRedirectUri: readOptionalTrimmed(env.SUPABASE_AUTH_REDIRECT_URI),
    devLogin,
    devAutologin: !isProduction && Boolean(env.SUPABASE_DEV_AUTOLOGIN) && devLogin !== null,
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
