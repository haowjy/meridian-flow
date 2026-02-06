import { createFileRoute } from "@tanstack/react-router";
import WorkspaceLayout from "@/features/workspace/components/WorkspaceLayout";

export const Route = createFileRoute("/_authenticated/projects/$slug")({
  component: ProjectWorkspace,
});

function ProjectWorkspace() {
  const { slug } = Route.useParams();
  // Pass slug as projectIdentifier - WorkspaceLayout resolves it to UUID via API
  // (Backend resolver accepts both UUID and slug)
  return <WorkspaceLayout key={`project-${slug}`} projectIdentifier={slug} />;
}
