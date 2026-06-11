import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Meridian</h1>
      <p>Phase 5 shell is available through the authenticated project workbench.</p>
      <p>
        <a href="/projects">Open default project</a>
      </p>
    </main>
  );
}
