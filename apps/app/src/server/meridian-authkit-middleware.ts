import { createMiddleware } from "@tanstack/react-start";
import { validateConfig } from "@workos/authkit-session";
import { getAuthkit } from "@workos/authkit-tanstack-react-start";

import { resolveAuthRedirectUri } from "./auth-redirect-uri";

let configValidated = false;

/**
 * AuthKit middleware with a per-request redirect URI (portless / Tailscale in dev).
 *
 * SYNC: keep aligned with `@workos/authkit-tanstack-react-start@0.8.6`
 * `dist/server/middleware-body.js` — only `redirectUri` resolution differs.
 * Prefer upstream `authkitMiddleware({ redirectUri })` when it supports per-request values.
 */
export function meridianAuthkitMiddleware() {
  return createMiddleware().server(async (args) => {
    const authkit = await getAuthkit();
    if (!configValidated) {
      await validateConfig();
      configValidated = true;
    }

    const redirectUri = resolveAuthRedirectUri(args.request);
    const { auth, refreshedSessionData } = await authkit.withAuth(args.request);
    const pendingHeaders = new Headers();

    const result = await args.next({
      context: {
        auth: () => auth,
        request: args.request,
        redirectUri,
        __setPendingHeader: (key: string, value: string) => {
          if (key.toLowerCase() === "set-cookie") {
            pendingHeaders.append(key, value);
          } else {
            pendingHeaders.set(key, value);
          }
        },
      },
    });

    if (refreshedSessionData) {
      const { response: sessionResponse } = await authkit.saveSession(
        undefined,
        refreshedSessionData,
      );
      for (const cookie of sessionResponse?.headers.getSetCookie() ?? []) {
        pendingHeaders.append("Set-Cookie", cookie);
      }
    }

    const headerEntries = [...pendingHeaders];
    if (headerEntries.length === 0) {
      return result;
    }

    const newResponse = new Response(result.response.body, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
    });
    for (const [key, value] of headerEntries) {
      if (key.toLowerCase() === "set-cookie") {
        newResponse.headers.append(key, value);
      } else {
        newResponse.headers.set(key, value);
      }
    }
    return { ...result, response: newResponse };
  });
}
