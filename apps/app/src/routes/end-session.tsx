import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAuth, signOut } from "@workos/authkit-tanstack-react-start";

import { resolveAuthRedirectUri } from "@/server/auth-redirect-uri";
import { getAppServerConfig } from "@/server/config";
import { requestFromServerHeaders } from "@/server/ssr-request";

const endSession = createServerFn({ method: "GET" }).handler(async () => {
  const { landingUrl } = getAppServerConfig();
  // With no WorkOS session, an absolute returnTo makes signOut redirect to itself forever
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

export const Route = createFileRoute("/end-session")({
  preload: false,
  loader: () => endSession(),
});
