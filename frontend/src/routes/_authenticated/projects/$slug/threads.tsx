import { createFileRoute } from "@tanstack/react-router";
import WorkspaceLayout from "@/features/workspace/components/WorkspaceLayout";

export const Route = createFileRoute("/_authenticated/projects/$slug/threads")({
  component: ThreadsWorkspace,
});

function ThreadsWorkspace() {
  const { slug } = Route.useParams();
  return <WorkspaceLayout key={`project-${slug}`} projectIdentifier={slug} />;
}
