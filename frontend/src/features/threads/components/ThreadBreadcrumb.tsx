import { CompactBreadcrumb, type BreadcrumbSegment } from '@/shared/components/ui/CompactBreadcrumb'

interface ThreadBreadcrumbProps {
  projectName?: string | null
  threadTitle?: string | null
}

/**
 * Compact breadcrumb for the thread header, showing Project / Thread title.
 */
export function ThreadBreadcrumb({ projectName, threadTitle }: ThreadBreadcrumbProps) {
  const segments: BreadcrumbSegment[] = [
    { label: projectName ?? 'Project' }
  ]

  if (threadTitle) {
    segments.push({ label: threadTitle, title: threadTitle })
  }

  return <CompactBreadcrumb segments={segments} />
}
