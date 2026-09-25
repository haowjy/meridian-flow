import { createStart } from "@tanstack/react-start";

import { meridianAuthkitMiddleware } from "./server/meridian-authkit-middleware";
import { releaseIdentityMiddleware } from "./server/release-identity-middleware";

/**
 * Configure TanStack Start with AuthKit middleware.
 * Redirect URI follows the request host in dev (portless + Tailscale).
 */
export const startInstance = createStart(() => {
  return {
    requestMiddleware: [releaseIdentityMiddleware(), meridianAuthkitMiddleware()],
  };
});
