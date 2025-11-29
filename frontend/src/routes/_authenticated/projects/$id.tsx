import { createFileRoute } from '@tanstack/react-router'
import WorkspaceLayout from '@/features/workspace/components/WorkspaceLayout'

export const Route = createFileRoute('/_authenticated/projects/$id')({
  component: ProjectWorkspace,
})

function ProjectWorkspace() {
  const { id } = Route.useParams()
  return <WorkspaceLayout key={`project-${id}`} projectId={id} />
}
