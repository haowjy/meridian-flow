const APP_ENV_PASSTHROUGH_KEYS = [
  "DATABASE_URL",
  "TEST_USER_EMAIL",
  "TEST_USER_PASSWORD",
  "TEST_USER_ID",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "WORKOS_REDIRECT_URI",
  "WORKOS_DEV_LOGIN_EMAIL",
  "WORKOS_DEV_LOGIN_PASSWORD",
  "WORKOS_DEV_LOGIN_USER_ID",
  "WORKOS_DEV_AUTOLOGIN",
  "MODEL_PROVIDER",
  "MODEL_CALL_TIMEOUT_MS",
  "MODEL_REQUEST_DEBUG_CAPTURE",
] as const;

const PROVIDER_API_KEY_PASSTHROUGH_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

export const REAL_MODEL_PROVIDER_VALUES = ["anthropic", "openai", "auto"] as const;

const REAL_MODEL_PROVIDERS = new Set<string>(REAL_MODEL_PROVIDER_VALUES);

/** Parent-shell API keys override `.env` only when the developer explicitly opts into real models. */
export function shouldPassthroughProviderApiKeys(env: NodeJS.ProcessEnv): boolean {
  const provider = env.MODEL_PROVIDER;
  return provider !== undefined && REAL_MODEL_PROVIDERS.has(provider);
}

/**
 * Shell snippet run after sourcing `.env` and parent passthrough exports.
 * Clears provider keys inherited from the parent tmux shell or present in `.env`
 * unless MODEL_PROVIDER explicitly opts into real providers.
 */
export function buildProviderApiKeyGuardShell(): string {
  const providerPattern = REAL_MODEL_PROVIDER_VALUES.join("|");
  const keys = PROVIDER_API_KEY_PASSTHROUGH_KEYS.join(" ");
  return `; case "\${MODEL_PROVIDER:-}" in ${providerPattern}) ;; *) unset ${keys} ;; esac`;
}

export function resolveAppEnvPassthroughKeys(env: NodeJS.ProcessEnv): string[] {
  const keys: string[] = APP_ENV_PASSTHROUGH_KEYS.filter((key) => env[key] !== undefined);

  if (shouldPassthroughProviderApiKeys(env)) {
    for (const key of PROVIDER_API_KEY_PASSTHROUGH_KEYS) {
      if (env[key] !== undefined) {
        keys.push(key);
      }
    }
  }

  return keys;
}
