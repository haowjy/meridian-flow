import { createFileRoute } from "@tanstack/react-router";
import { Route as AuthenticatedRoute } from "../_authenticated";

export const Route = createFileRoute("/_authenticated/auth-check")({
  component: AuthCheckPage,
});

function AuthCheckPage() {
  const { user } = AuthenticatedRoute.useLoaderData();
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1 data-testid="auth-check-title">Authenticated</h1>
      <p data-testid="auth-check-user">{user.email ?? user.userId}</p>
    </main>
  );
}
