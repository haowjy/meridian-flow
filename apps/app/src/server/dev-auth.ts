import { getAppServerConfig } from "./config";

/**
 * True when this process is configured to allow WorkOS dev-autologin:
 * non-production NODE_ENV plus all three WORKOS_DEV_* env vars present.
 *
 * Canonical predicate — must be the single source of truth across the
 * unauth redirect, the dev-login page gate, and the API endpoint gate.
 */
export function isDevAutologinEnabled(): boolean {
  return getAppServerConfig().devAutologin;
}
