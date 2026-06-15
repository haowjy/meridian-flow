import { createFileRoute, notFound } from "@tanstack/react-router";
import { getDevLoginEnabled } from "@/server/dev-login";

export const Route = createFileRoute("/dev-login")({
  loader: async () => {
    if (!(await getDevLoginEnabled())) throw notFound();
  },
  component: DevLoginPage,
});

function DevLoginPage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Meridian dev login</h1>
      <p>
        <a href="/api/auth/dev-login">Authenticate test user</a>
      </p>
    </main>
  );
}
