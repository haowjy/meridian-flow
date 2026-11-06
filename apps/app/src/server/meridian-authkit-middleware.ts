import { devAuthAppliesToRequest, resolveDevAuthUser } from "@meridian/contracts/dev-auth";
import { createMiddleware } from "@tanstack/react-start";
import { type AuthResult, validateConfig } from "@workos/authkit-session";
import { getAuthkit } from "@workos/authkit-tanstack-react-start";

import { resolveAuthRedirectUri } from "./auth-redirect-uri";

let configValidated = false;

/**
 * The AuthKit-shaped auth for the dev user. Empty `sessionId` makes AuthKit's
 * `signOut` return to `/` without a WorkOS call; the tokens are never read.
 */
function devAuthResult(dev: { externalId: string; email: string }): AuthResult {
  const now = new Date().toISOString();
  return {
    user: {
      object: "user",
      id: dev.externalId,
      email: dev.email,
      emailVerified: true,
      firstName: null,
      lastName: null,
      profilePictureUrl: null,
      lastSignInAt: now,
      createdAt: now,
      updatedAt: now,
      externalId: null,
      metadata: {},
      name: dev.externalId,
      locale: null,
    },
    sessionId: "",
    accessToken: "",
    refreshToken: "",
    claims: { sub: dev.externalId, sid: "", iss: "", exp: 0, iat: 0 },
  };
}

/**
 * AuthKit middleware with a per-request redirect URI (portless / Tailscale in dev).
 *
 * SYNC: keep aligned with `@workos/authkit-tanstack-react-start@0.8.6`
 * `dist/server/middleware-body.js` — only `redirectUri` resolution differs.
 * Prefer upstream `authkitMiddleware({ redirectUri })` when it supports per-request values.
 */
export function meridianAuthkitMiddleware() {
  return createMiddleware().server(async (args) => {
    // Raw process.env on purpose: see `@meridian/contracts/dev-auth`.
    const devUser = resolveDevAuthUser(process.env);
    if (devUser) {
      const auth: AuthResult = devAuthAppliesToRequest(args.request)
        ? devAuthResult(devUser)
        : { user: null };
      return args.next({
        context: {
          auth: () => auth,
          request: args.request,
          redirectUri: "",
          __setPendingHeader: () => {},
        },
      });
    }

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
