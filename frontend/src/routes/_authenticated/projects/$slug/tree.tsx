import { createFileRoute } from '@tanstack/react-router'
import WorkspaceLayout from '@/features/workspace/components/WorkspaceLayout'

export const Route = createFileRoute('/_authenticated/projects/$slug/tree')({
  component: TreeWorkspace,
})

function TreeWorkspace() {
  const { slug } = Route.useParams()
  return <WorkspaceLayout key={`project-${slug}`} projectIdentifier={slug} />
}
