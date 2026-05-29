const AUTH_TOKEN_STORAGE_KEY = "meridian:auth-token"

/**
 * Returns the bearer token for REST and WebSocket auth.
 *
 * TODO(phase-4-auth): Replace with Supabase session refresh when v2 auth ships.
 * Call sites should depend on this function, not on localStorage directly.
 */
export async function getAccessToken(): Promise<string> {
  if (typeof localStorage === "undefined") return ""
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? ""
}
