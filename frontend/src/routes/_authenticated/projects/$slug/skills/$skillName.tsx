import { createFileRoute } from "@tanstack/react-router";
import WorkspaceLayout from "@/features/workspace/components/WorkspaceLayout";

export const Route = createFileRoute(
  "/_authenticated/projects/$slug/skills/$skillName",
)({
  component: SkillWorkspace,
});

/**
 * Skill space route.
 * Shows space layout with skill editor open.
 * URL uses skill name (e.g., "writing-coach") as identifier.
 */
function SkillWorkspace() {
  const { slug, skillName } = Route.useParams();
  // TanStack Router may already decode, but be explicit for safety
  // Handles skill names with special characters (spaces, ampersands, etc.)
  const decodedSkillName = decodeURIComponent(skillName);

  return (
    <WorkspaceLayout
      projectIdentifier={slug}
      initialSkillName={decodedSkillName}
    />
  );
}
