import { createFileRoute } from "@tanstack/react-router";
import WorkspaceLayout from "@/features/workspace/components/WorkspaceLayout";
import { decodeDocumentPath } from "@/core/lib/panelHelpers";

// Splat route: catches all segments after /documents/
// Examples:
//   /documents/readme -> _splat = "readme"
//   /documents/characters/heroes/aria -> _splat = "characters/heroes/aria"
export const Route = createFileRoute(
  "/_authenticated/projects/$slug/documents/$",
)({
  component: DocumentWorkspace,
});

function DocumentWorkspace() {
  const { slug, _splat } = Route.useParams();
  // _splat is URL-encoded by the router; decode to get actual document path
  // decodeDocumentPath handles both single and double-encoded URLs
  const decodedPath = _splat ? decodeDocumentPath(_splat) : undefined;
  // WorkspaceLayout resolves the path to document UUID
  return (
    <WorkspaceLayout
      key={`project-${slug}`}
      projectIdentifier={slug}
      initialDocumentPath={decodedPath}
    />
  );
}
