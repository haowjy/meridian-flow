import { getAppServerConfig } from "./config";

/** Canonical dev-autologin predicate for Supabase-backed local development. */
export function isDevAutologinEnabled(): boolean {
  return getAppServerConfig().devAutologin;
}
