/**
 * Keys `pnpm dev` exports into the stack's tmux pane: what it computes
 * (`MERIDIAN_API_ORIGIN`, `APP_DEBUG`) and the non-secret overrides a caller
 * sets on the command line (`MODEL_PROVIDER=mock pnpm dev`) — a pane does not
 * inherit the caller's environment when a tmux server is already running.
 * Everything else, secrets included, reaches a service through
 * `with-dev-env.ts`, never the command string.
 */
const PASSTHROUGH_KEYS = [
  "TEST_USER_ID",
  "WORKOS_CLIENT_ID",
  "WORKOS_REDIRECT_URI",
  "WORKOS_DEV_LOGIN_USER_ID",
  "WORKOS_DEV_AUTOLOGIN",
  "MERIDIAN_API_ORIGIN",
  "MODEL_PROVIDER",
  "MOCK_MODEL_RESPONSE",
  "LIVE_TEST_MODEL",
  "MODEL_CALL_TIMEOUT_MS",
  "MODEL_CALL_STALL_MS",
  "APP_DEBUG",
  "OBS_VERBOSE",
  "LOG_DIR",
  "EVENT_PROVIDER",
  "LOG_RETENTION_DAYS",
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
      ? PASSTHROUGH_KEYS
      : [...PASSTHROUGH_KEYS, ...DEV_ONLY_PASSTHROUGH_KEYS];
  return keys.filter((key) => env[key] !== undefined);
}
