import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAuth, signOut } from "@workos/authkit-tanstack-react-start";

import { resolveAuthRedirectUri } from "@/server/auth-redirect-uri";
import { getAppServerConfig } from "@/server/config";
import { requestFromServerHeaders } from "@/server/ssr-request";

// WorkOS sends the browser to `returnTo` after ending its session. It must be
// absolute and registered under WorkOS → Redirects → Sign-out redirects; an
// unregistered one lands on the environment's default logout URI. `MERIDIAN_WWW_ORIGIN`
// is one fixed origin, so in dev a tailnet device lands on an unreachable `.localhost`.
// The `/login` fallback follows the sign-in callback's origin rules.
const endSession = createServerFn({ method: "GET" }).handler(async () => {
  const { landingUrl } = getAppServerConfig();
  // With no WorkOS session `signOut` hands `returnTo` to the router as a path, so an
  // absolute one redirects to itself forever. Signed-out and bypass requests land here.
  const auth = await getAuth();
  if (!auth.user || !auth.sessionId) {
    throw landingUrl
      ? redirect({ href: landingUrl, reloadDocument: true })
      : redirect({ to: "/login", reloadDocument: true });
  }
  const request = requestFromServerHeaders();
  const signInUrl = request ? new URL("/login", resolveAuthRedirectUri(request)).href : undefined;
  await signOut({ data: { returnTo: landingUrl ?? signInUrl } });
});

export const Route = createFileRoute("/logout")({
  preload: false,
  loader: () => endSession(),
});
