/**
 * /logout route — clears the WorkOS session via `signOut()` in its loader.
 * `signOut()` answers with a redirect to api.workos.com, which a client-side
 * navigation would `fetch` and fail on CORS: reach this route with a full
 * document navigation (`<a href="/logout">`), never `<Link>`.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { signOut } from "@workos/authkit-tanstack-react-start";

import { resolveAuthRedirectUri } from "@/server/auth-redirect-uri";
import { requestFromServerHeaders } from "@/server/ssr-request";

// WorkOS sends the browser to `returnTo` after ending its session. It must be
// absolute and registered under WorkOS → Redirects → Sign-out redirects; an
// unregistered one lands on the environment's default logout URI. Same origin
// rules as the sign-in callback, so Portless and Tailscale hosts both work.
const endSession = createServerFn({ method: "GET" }).handler(async () => {
  const request = requestFromServerHeaders();
  const returnTo = request ? new URL("/login", resolveAuthRedirectUri(request)).href : undefined;
  await signOut({ data: { returnTo } });
});

export const Route = createFileRoute("/logout")({
  preload: false,
  loader: () => endSession(),
});
