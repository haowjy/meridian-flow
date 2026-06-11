import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { bootstrapDefaultProject } from "@/client/phase5-api";
import { ProjectShellStyles } from "@/features/project-shell/styles";

export const Route = createFileRoute("/_authenticated/projects/")({
  component: ProjectsIndex,
});

function ProjectsIndex() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bootstrapDefaultProject()
      .then((bootstrap) =>
        navigate({
          to: "/projects/$projectId/agent",
          params: { projectId: bootstrap.projectId },
          replace: true,
        }),
      )
      .catch((bootstrapError) =>
        setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError)),
      );
  }, [navigate]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <ProjectShellStyles />
      <h1>Opening Meridian project…</h1>
      {error ? <p data-testid="bootstrap-error">{error}</p> : null}
    </main>
  );
}
