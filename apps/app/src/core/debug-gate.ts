/** Build-time gate shared by the dev-only debug feature and its core adapters. */

/**
 * Build-time gate. If false, the overlay module exports a no-op `enabled` and
 * the build pipeline strips its imports as dead code.
 */
export const DEBUG_FEATURE_ALLOWED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DEBUG_OVERLAY === "1";
