const APP_ENV_PASSTHROUGH_KEYS = [
  "DATABASE_URL",
  "TEST_USER_ID",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "WORKOS_REDIRECT_URI",
  "WORKOS_DEV_LOGIN_EMAIL",
  "WORKOS_DEV_LOGIN_PASSWORD",
  "WORKOS_DEV_LOGIN_USER_ID",
  "WORKOS_DEV_AUTOLOGIN",
  "MERIDIAN_API_ORIGIN",
  "MODEL_PROVIDER",
  "MODEL_CALL_TIMEOUT_MS",
  "MODEL_CALL_STALL_MS",
  "APP_DEBUG",
  "OBS_VERBOSE",
  "FLOW_ANTHROPIC_API_KEY",
  "FLOW_OPENAI_API_KEY",
  "FLOW_DEEPSEEK_API_KEY",
  "FLOW_OPENROUTER_API_KEY",
  "FLOW_OPENROUTER_BASE_URL",
] as const;

/** The crash controller's keys (collab's `collab-test-hooks.ts`), never passed to production. */
const DEV_ONLY_PASSTHROUGH_KEYS = ["COLLAB_CRASH_AT", "COLLAB_CRASH_ARM"] as const;

export function resolveAppEnvPassthroughKeys(env: NodeJS.ProcessEnv): string[] {
  const keys: readonly string[] =
    env.NODE_ENV === "production"
      ? APP_ENV_PASSTHROUGH_KEYS
      : [...APP_ENV_PASSTHROUGH_KEYS, ...DEV_ONLY_PASSTHROUGH_KEYS];
  return keys.filter((key) => env[key] !== undefined);
}
