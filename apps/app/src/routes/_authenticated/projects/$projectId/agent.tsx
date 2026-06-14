// @ts-nocheck
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { bootstrapDefaultProject, type DefaultBootstrap } from "@/client/phase5-api";
import { ProjectShell } from "@/features/project-shell/project-shell";
import { ProjectShellStyles } from "@/features/project-shell/styles";

export const Route = createFileRoute("/_authenticated/projects/$projectId/agent")({
  component: ProjectAgentRoute,
});

function ProjectAgentRoute() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<DefaultBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    bootstrapDefaultProject()
      .then((loaded) => {
        if (cancelled) return;
        setBootstrap(loaded);
        if (projectId !== loaded.projectId) {
          void navigate({
            to: "/projects/$projectId/agent",
            params: { projectId: loaded.projectId },
            replace: true,
          });
        }
      })
      .catch((bootstrapError) => {
        if (cancelled) return;
        setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
      });

    return () => {
      cancelled = true;
    };
  }, [navigate, projectId]);

  return (
    <>
      <ProjectShellStyles />
      {bootstrap ? (
        <ProjectShell
          documentId={bootstrap.documentId}
          projectId={bootstrap.projectId}
          threadId={bootstrap.threadId}
          uri={bootstrap.uri}
          workId={bootstrap.workId}
        />
      ) : (
        <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
          <h1>Opening Meridian project…</h1>
          {error ? <p data-testid="bootstrap-error">{error}</p> : null}
        </main>
      )}
    </>
  );
}
