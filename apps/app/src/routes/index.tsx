import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Meridian</h1>
      <p>Phase 0 app skeleton — authenticated workspace routes land in Phase 2+.</p>
    </main>
  );
}
