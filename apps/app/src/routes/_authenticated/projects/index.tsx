import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { bootstrapDefaultProject } from "@/client/phase5-api";
import { ProjectShellStyles } from "@/features/project-shell/styles";
import { resolveOnboardingGate } from "@/server/onboarding-gate";

export const Route = createFileRoute("/_authenticated/projects/")({
  loader: async () => {
    const gate = await resolveOnboardingGate();
    if (!gate.ok) {
      return { gateBlocked: true as const };
    }
    if (gate.status.shouldOnboard) {
      throw redirect({ to: "/onboarding" });
    }
    return { gateBlocked: false as const };
  },
  component: ProjectsIndex,
});

function ProjectsIndex() {
  const { gateBlocked } = Route.useLoaderData();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (gateBlocked) return;

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
  }, [gateBlocked, navigate]);

  if (gateBlocked) {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <ProjectShellStyles />
        <h1>Could not verify onboarding status</h1>
        <p data-testid="onboarding-gate-error">
          Meridian could not confirm whether setup is required. Refresh or try again in a moment.
        </p>
      </main>
    );
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <ProjectShellStyles />
      <h1>Opening Meridian project…</h1>
      {error ? <p data-testid="bootstrap-error">{error}</p> : null}
    </main>
  );
}
