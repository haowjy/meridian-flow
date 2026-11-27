import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAuth, signOut } from "@workos/authkit-tanstack-react-start";

import { getAuthMe } from "@/client/api/auth-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import { resolveAuthRedirectUri } from "@/server/auth-redirect-uri";
import { getAppServerConfig } from "@/server/config";
import { requestFromServerHeaders } from "@/server/ssr-request";

const endSession = createServerFn({ method: "GET" })
  .validator((account: string | null) => account)
  .handler(async ({ data: account }) => {
    const { landingUrl } = getAppServerConfig();
    const signedOut = landingUrl
      ? redirect({ href: landingUrl, reloadDocument: true })
      : redirect({ to: "/login", reloadDocument: true });
    const auth = await getAuth();
    if (!auth.user) throw signedOut;
    if (account && !(await sessionIsAccount(account)))
      throw redirect({ to: "/", reloadDocument: true });
    // With no WorkOS session, an absolute returnTo makes signOut redirect to itself forever
    if (!auth.sessionId) throw signedOut;
    const request = requestFromServerHeaders();
    const signInUrl = request ? new URL("/login", resolveAuthRedirectUri(request)).href : undefined;
    await signOut({ data: { returnTo: landingUrl ?? signInUrl } });
  });

async function sessionIsAccount(account: string): Promise<boolean> {
  try {
    return (await getAuthMe(ssrApiRequestInit())).user.userId === account;
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/end-session")({
  preload: false,
  loader: ({ location }) =>
    endSession({ data: new URLSearchParams(location.searchStr).get("account") }),
});
