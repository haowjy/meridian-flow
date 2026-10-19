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
  "DRAIN_APPLY_SETTLEMENT",
  "OBS_VERBOSE",
  "FLOW_ANTHROPIC_API_KEY",
  "FLOW_OPENAI_API_KEY",
  "FLOW_DEEPSEEK_API_KEY",
  "FLOW_OPENROUTER_API_KEY",
  "FLOW_OPENROUTER_BASE_URL",
] as const;

/** The hook controller's keys (the server's `shared/test-hook-controller.ts`), never passed to production. */
const DEV_ONLY_PASSTHROUGH_KEYS = [
  "HOOK_CRASH_AT",
  "HOOK_CRASH_ARM",
  "HOOK_PAUSE_AT",
  "HOOK_PAUSE_FILE",
] as const;

export function resolveAppEnvPassthroughKeys(env: NodeJS.ProcessEnv): string[] {
  const keys: readonly string[] =
    env.NODE_ENV === "production"
      ? APP_ENV_PASSTHROUGH_KEYS
      : [...APP_ENV_PASSTHROUGH_KEYS, ...DEV_ONLY_PASSTHROUGH_KEYS];
  return keys.filter((key) => env[key] !== undefined);
}
