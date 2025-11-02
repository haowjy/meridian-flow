// Note: params must be awaited in Next.js 16
import WorkspaceLayout from './components/WorkspaceLayout'

export default async function ProjectWorkspace({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return <WorkspaceLayout projectId={id} />
}
