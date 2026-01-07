import { createFileRoute } from '@tanstack/react-router'
import WorkspaceLayout from '@/features/workspace/components/WorkspaceLayout'

// Splat route: catches all segments after /documents/
// Examples:
//   /documents/readme → _splat = "readme"
//   /documents/characters/heroes/aria → _splat = "characters/heroes/aria"
export const Route = createFileRoute('/_authenticated/projects/$slug/documents/$')({
  component: DocumentWorkspace,
})

function DocumentWorkspace() {
  const { slug, _splat } = Route.useParams()
  // _splat contains the full path-based slug (e.g., "characters/heroes/aria")
  // WorkspaceLayout resolves it to document UUID
  return <WorkspaceLayout key={`project-${slug}`} projectIdentifier={slug} initialDocumentSlug={_splat} />
}
