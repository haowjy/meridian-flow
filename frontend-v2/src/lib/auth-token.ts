const AUTH_TOKEN_STORAGE_KEY = "meridian:auth-token"

/**
 * Returns the bearer token for REST and WebSocket auth.
 *
 * In dev mode, also checks VITE_ACCESS_TOKEN env var as a fallback
 * so developers don't need to manually set localStorage.
 *
 * TODO(phase-4-auth): Replace with Supabase session refresh when v2 auth ships.
 * Call sites should depend on this function, not on localStorage directly.
 */
export async function getAccessToken(): Promise<string> {
  if (typeof localStorage === "undefined") return ""

  const stored = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
  if (stored) return stored

  // Dev fallback: read from Vite env var and auto-persist
  if (import.meta.env.DEV) {
    const envToken = import.meta.env.VITE_ACCESS_TOKEN as string | undefined
    if (envToken) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, envToken)
      return envToken
    }
  }

  return ""
}
