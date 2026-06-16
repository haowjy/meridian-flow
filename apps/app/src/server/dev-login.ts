import { createServerFn } from "@tanstack/react-start";

import { getAppServerConfig } from "./config";
import { isDevAutologinEnabled } from "./dev-auth";

export const getDevLoginEnabled = createServerFn({ method: "GET" }).handler(async () => {
  return isDevAutologinEnabled();
});

/**
 * Server-side resolver for the dev user's email when dev-autologin is enabled.
 * Env values never reach the client bundle.
 */
export const devLoginEmail = createServerFn({ method: "GET" }).handler(
  async (): Promise<string | null> => {
    if (!isDevAutologinEnabled()) return null;
    return getAppServerConfig().workosDevLogin?.email ?? null;
  },
);
