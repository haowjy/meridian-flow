const AUTH_TOKEN_STORAGE_KEY = "meridian:auth-token"

/**
 * Returns the bearer token for REST and WebSocket auth.
 *
 * Synchronous — reads from localStorage (+ dev env fallback).
 * The async wrapper is intentionally kept for the WsClient contract
 * (getToken returns Promise<string>) but the work is synchronous.
 *
 * TODO(phase-4-auth): Replace with Supabase session refresh when v2 auth ships.
 * Call sites should depend on this function, not on localStorage directly.
 */
export function getAccessTokenSync(): string {
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

/**
 * Async wrapper for WsClient.getToken contract.
 * Delegates to getAccessTokenSync — no actual async work.
 */
export async function getAccessToken(): Promise<string> {
  return getAccessTokenSync()
}
