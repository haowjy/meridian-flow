import { createFileRoute } from '@tanstack/react-router'
import WorkspaceLayout from '@/features/workspace/components/WorkspaceLayout'

export const Route = createFileRoute('/_authenticated/projects/$id/documents/$documentId')({
  component: DocumentWorkspace,
})

function DocumentWorkspace() {
  const { id, documentId } = Route.useParams()
  return <WorkspaceLayout key={`project-${id}`} projectId={id} initialDocumentId={documentId} />
}
