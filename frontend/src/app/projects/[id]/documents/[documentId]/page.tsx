// Note: params must be awaited in Next.js 16
import WorkspaceLayout from '../../components/WorkspaceLayout'

export default async function ProjectDocumentWorkspace({
  params,
}: {
  params: Promise<{ id: string; documentId: string }>
}) {
  const { id, documentId } = await params

  return <WorkspaceLayout projectId={id} initialDocumentId={documentId} />
}
