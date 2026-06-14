// @ts-nocheck
import { createFileRoute, Link } from "@tanstack/react-router";
import { getDevLoginEnabled } from "@/server/dev-login";

export const Route = createFileRoute("/login")({
  loader: async () => ({ devLoginEnabled: await getDevLoginEnabled() }),
  component: LoginPage,
});

function LoginPage() {
  const { devLoginEnabled } = Route.useLoaderData();

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Log in to Meridian</h1>
      {devLoginEnabled ? (
        <>
          <p>Local Phase 2 auth uses the Supabase test user from the dev environment.</p>
          <p>
            <a href="/api/auth/dev-login">Continue with dev login</a>
          </p>
        </>
      ) : (
        <p>Dev login is disabled in this environment.</p>
      )}
      <p>
        <Link to="/">Back home</Link>
      </p>
    </main>
  );
}
