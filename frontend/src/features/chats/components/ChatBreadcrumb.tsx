import { CompactBreadcrumb, type BreadcrumbSegment } from '@/shared/components/ui/CompactBreadcrumb'

interface ChatBreadcrumbProps {
  projectName?: string | null
  chatTitle?: string | null
}

/**
 * Compact breadcrumb for the chat header, showing Project / Chat title.
 */
export function ChatBreadcrumb({ projectName, chatTitle }: ChatBreadcrumbProps) {
  const segments: BreadcrumbSegment[] = [
    { label: projectName ?? 'Project' }
  ]

  if (chatTitle) {
    segments.push({ label: chatTitle, title: chatTitle })
  }

  return <CompactBreadcrumb segments={segments} />
}
